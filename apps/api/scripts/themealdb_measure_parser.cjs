// Parses TheMealDB's free-text strMeasureN strings into {quantity, unit}.
// Reused nowhere else — this is the one new piece of logic Part B needs;
// everything downstream (unit classification, nutrition, cost) reuses the
// existing recipe_cost.service.js / canonical_resolver.service.js engine.
const UNICODE_FRACTIONS = {
  "¼": 0.25, "½": 0.5, "¾": 0.75,
  "⅓": 1 / 3, "⅔": 2 / 3,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1 / 6, "⅚": 5 / 6,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

function parseMeasure(raw) {
  const measure = String(raw || "").trim();
  if (!measure) return { quantity: 1, unit: "" };

  // Unicode fraction, optionally preceded by a whole number: "1 ½", "½"
  const unicodeMatch = measure.match(
    /^(\d+)?\s*([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*(.*)$/,
  );
  if (unicodeMatch) {
    const whole = unicodeMatch[1] ? parseInt(unicodeMatch[1], 10) : 0;
    const qty = whole + UNICODE_FRACTIONS[unicodeMatch[2]];
    return { quantity: qty, unit: unicodeMatch[3].trim() };
  }

  // Mixed number: "1 1/2 cups"
  const mixedMatch = measure.match(/^(\d+)\s+(\d+)\/(\d+)\s*(.*)$/);
  if (mixedMatch) {
    const qty = parseInt(mixedMatch[1], 10) + parseInt(mixedMatch[2], 10) / parseInt(mixedMatch[3], 10);
    return { quantity: qty, unit: mixedMatch[4].trim() };
  }

  // Simple fraction: "1/2 cup"
  const fracMatch = measure.match(/^(\d+)\/(\d+)\s*(.*)$/);
  if (fracMatch) {
    const qty = parseInt(fracMatch[1], 10) / parseInt(fracMatch[2], 10);
    return { quantity: qty, unit: fracMatch[3].trim() };
  }

  // Range: "2-3 tbsp" -> take the first number
  const rangeMatch = measure.match(/^(\d+(?:\.\d+)?)\s*-\s*\d+(?:\.\d+)?\s*(.*)$/);
  if (rangeMatch) {
    return { quantity: parseFloat(rangeMatch[1]), unit: rangeMatch[2].trim() };
  }

  // Plain number, possibly decimal: "200g", "1.5 cups", "2 cloves"
  const plainMatch = measure.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  if (plainMatch) {
    return { quantity: parseFloat(plainMatch[1]), unit: plainMatch[2].trim() };
  }

  // No leading number at all: "to taste", "a pinch", "Salt and pepper"
  return { quantity: 1, unit: measure };
}

module.exports = { parseMeasure };
