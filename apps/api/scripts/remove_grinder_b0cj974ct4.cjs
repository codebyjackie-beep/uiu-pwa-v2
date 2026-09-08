// HANDOFF: permanently remove B0CJ974CT4 (TOMEEM dual-canister grinder) — no more waiting for a
// photo. Neither scrapeProductImage() nor searchProductImageByAsin() ever found a confident photo
// (2026-08-30/2026-09-06 investigated already — not a code bug, listing has no clean gallery
// photo). Jackie decided: delete outright, don't leave a residue, don't backfill a replacement.
//
// Scope:
//   1. affiliate_products — delete the doc for this ASIN entirely (not just clear imageUrl).
//   2. ig_content_drafts — find any draft referencing this ASIN (top-level `asin` field for
//      single-product posts, or `collageProducts[].asin` for the 9-grid collage posts).
//        - status "pending": safe to delete/reject outright (never published).
//        - status "approved" (i.e. already published): DO NOT touch — just report it so Jackie
//          can decide, per the HANDOFF's explicit instruction not to unilaterally handle
//          already-published content.
//
// Default: dry run (prints before-counts + what would be deleted/found, writes nothing).
// Pass --write to actually delete affiliate_products doc + pending drafts referencing this ASIN.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");
const ASIN = "B0CJ974CT4";

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const productsCol = db.collection("affiliate_products");
    const draftsCol = db.collection("ig_content_drafts");

    const before = {
      affiliateProductsTotal: await productsCol.countDocuments({}),
      igContentDraftsTotal: await draftsCol.countDocuments({}),
    };

    const targetProduct = await productsCol.find({ asin: ASIN }).toArray();

    const referencingDrafts = await draftsCol
      .find({ $or: [{ asin: ASIN }, { "collageProducts.asin": ASIN }] })
      .project({ status: 1, targetAccount: 1, postType: 1, asin: 1, publishedAt: 1, publishedMediaId: 1, createdAt: 1, "collageProducts.asin": 1 })
      .toArray();

    console.log(`Found ${targetProduct.length} affiliate_products doc(s) for ASIN ${ASIN}:`);
    for (const p of targetProduct) {
      console.log(`  _id=${p._id}  productName="${p.productName}"  imageUrl="${p.imageUrl}"  lastUsedAt=${p.lastUsedAt}`);
    }

    console.log(`\nFound ${referencingDrafts.length} ig_content_drafts referencing ASIN ${ASIN}:`);
    const pendingDrafts = [];
    const publishedDrafts = [];
    for (const d of referencingDrafts) {
      const viaCollage = d.asin !== ASIN;
      console.log(
        `  _id=${d._id}  status=${d.status}  targetAccount=${d.targetAccount}  postType=${d.postType ?? "single"}  viaCollage=${viaCollage}  publishedAt=${d.publishedAt ?? "-"}  publishedMediaId=${d.publishedMediaId ?? "-"}`,
      );
      if (d.status === "pending") {
        pendingDrafts.push(d._id);
      } else if (d.status === "approved") {
        publishedDrafts.push(d);
      }
    }

    if (publishedDrafts.length > 0) {
      console.log(`\n*** WARNING: ${publishedDrafts.length} ALREADY-PUBLISHED draft(s) reference this ASIN — NOT touching these. Reporting to Jackie: ***`);
      for (const d of publishedDrafts) {
        console.log(`  _id=${d._id}  publishedAt=${d.publishedAt}  publishedMediaId=${d.publishedMediaId}  targetAccount=${d.targetAccount}  postType=${d.postType ?? "single"}`);
      }
    }

    let deletedProducts = 0;
    let deletedDrafts = 0;
    if (WRITE) {
      const productResult = await productsCol.deleteMany({ asin: ASIN });
      deletedProducts = productResult.deletedCount;
      if (pendingDrafts.length > 0) {
        const draftResult = await draftsCol.deleteMany({ _id: { $in: pendingDrafts } });
        deletedDrafts = draftResult.deletedCount;
      }
      console.log(`\nDeleted ${deletedProducts} affiliate_products doc(s), ${deletedDrafts} pending ig_content_drafts doc(s).`);
    } else {
      console.log("\nDRY RUN — no DB writes performed. Pass --write to commit.");
    }

    const after = {
      affiliateProductsTotal: await productsCol.countDocuments({}),
      igContentDraftsTotal: await draftsCol.countDocuments({}),
      affiliateProductsForAsin: await productsCol.countDocuments({ asin: ASIN }),
      igContentDraftsForAsin: await draftsCol.countDocuments({ $or: [{ asin: ASIN }, { "collageProducts.asin": ASIN }] }),
    };

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      asin: ASIN,
      before,
      after,
      foundAffiliateProducts: targetProduct.length,
      foundReferencingDrafts: referencingDrafts.length,
      pendingDraftsHandled: pendingDrafts.length,
      publishedDraftsNotTouched: publishedDrafts.map((d) => ({
        _id: String(d._id),
        publishedAt: d.publishedAt,
        publishedMediaId: d.publishedMediaId,
        targetAccount: d.targetAccount,
        postType: d.postType ?? "single",
      })),
      deletedProducts,
      deletedDrafts,
    };
    const reportPath = path.resolve(
      __dirname,
      "../../../../summaries",
      `2026-09-08_remove-grinder-b0cj974ct4-${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${reportPath}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
