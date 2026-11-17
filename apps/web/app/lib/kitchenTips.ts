/**
 * Home "Kitchen tip" card (Jackie 2026-11-16): a fixed, reviewed pool of practical kitchen tips.
 * Every day (UK date) three tips are picked for everyone; each app open shows one of the three.
 *
 * Content rules: no prices, no absolute food-safety promises. Storage, date-label and reheating
 * tips are written to follow Food Standards Agency / Love Food Hate Waste advice (not checked
 * line by line against the source — food-safety ids to review: 27, 29, 30, 32, 33, 36-39, 78).
 * Ids are stable — add new tips at the end, never renumber.
 */
export type KitchenTip = { id: number; text: string };

export const KITCHEN_TIPS: readonly KitchenTip[] = [
  // Keeping food fresh
  { id: 1, text: "Stand spring onions root-down in a glass with a little water and they stay crisp for longer. Change the water every couple of days." },
  { id: 2, text: "Keep potatoes somewhere cool and dark. Light turns them green and warmth makes them sprout." },
  { id: 3, text: "Store onions and potatoes apart. Kept together, both tend to spoil sooner." },
  { id: 4, text: "Bananas speed up ripening in the fruit around them. Keep them separate, unless you want that hard avocado ready sooner." },
  { id: 5, text: "Limp carrots or celery often crisp up again after half an hour in a bowl of cold water." },
  { id: 6, text: "Treat parsley and coriander like flowers: stand the stems in a little water, cover loosely and keep them in the fridge." },
  { id: 7, text: "Basil dislikes the cold. Keep it out of the fridge, with its stems in water on the worktop." },
  { id: 8, text: "Freeze bread ready-sliced and toast it straight from frozen. No more half-stale loaves." },
  { id: 9, text: "Tomatoes taste best at room temperature. Take them out of the fridge a little while before eating." },
  { id: 10, text: "Keep mushrooms in a paper bag rather than plastic. Paper lets moisture escape, so they turn slimy less quickly." },
  { id: 11, text: "Put a sheet of kitchen paper in the bag or box with salad leaves. It soaks up moisture and keeps them fresher." },
  { id: 12, text: "Wash berries just before you eat them, not before you store them. Damp berries go mouldy faster." },
  { id: 13, text: "Keep fresh ginger in the freezer and grate it straight from frozen. No need to peel it first." },
  { id: 14, text: "Fresh chillies freeze well whole. Slice them straight from the freezer when you need one." },
  { id: 15, text: "Wrap hard cheese in baking paper, then put it in a box or bag. It dries out less and does not sweat." },
  { id: 16, text: "Grate the end of a block of hard cheese and freeze it. Use it straight from frozen for cooking." },
  { id: 17, text: "Freeze leftover stock, wine or tomato purée in an ice cube tray, then drop a cube into your next sauce." },
  { id: 18, text: "Milk can be frozen. Pour a little out first so it has room to expand, defrost it in the fridge and shake well." },
  { id: 19, text: "Hard avocado? Put it in a paper bag with a banana for a day or two. Once ripe, the fridge holds it for a few more days." },
  { id: 20, text: "Half an avocado left? Keep the stone in, rub the cut side with lemon juice and wrap it tightly before chilling." },
  { id: 21, text: "Once opened, keep flour, rice and pasta in airtight containers. They stay dry and safe from cupboard pests." },
  { id: 22, text: "Honey gone solid? Stand the jar in a bowl of warm water and it will turn runny again." },
  { id: 23, text: "Brown sugar set like a brick? Put a slice of bread in the container overnight to soften it." },
  { id: 24, text: "Apples last much longer in the fridge than in the fruit bowl." },
  { id: 25, text: "Lemons and limes keep longer in the fridge than on the worktop." },
  { id: 26, text: "Cut the leafy tops off carrots, beetroot and radishes before storing. The leaves draw moisture out of the roots." },
  { id: 27, text: "Do not keep leftovers in an opened tin. Move them to a covered container before they go in the fridge." },
  { id: 28, text: "Move older items to the front of the fridge and cupboard when you unpack, so they get used first." },

  // Fridge and freezer
  { id: 29, text: "Check your fridge temperature now and then. The Food Standards Agency advises 5°C or below." },
  { id: 30, text: "Keep raw meat and fish covered on the bottom shelf of the fridge, so nothing can drip onto other food." },
  { id: 31, text: "Do not pack the fridge too full. Cold air needs room to move to keep everything properly chilled." },
  { id: 32, text: "\"Use by\" is about safety. \"Best before\" is about quality. Check which one is on the label before you bin something." },
  { id: 33, text: "Most food can be frozen right up to its use-by date. If you will not get to it in time, freeze it." },
  { id: 34, text: "Label and date everything that goes in the freezer. Frozen mystery tubs rarely get eaten." },
  { id: 35, text: "Freeze soups, sauces and mince flat in bags. They stack neatly and defrost much faster." },
  { id: 36, text: "Cool leftovers quickly and get them into the fridge within one to two hours." },
  { id: 37, text: "Cool leftover rice as quickly as you can, ideally within an hour, then keep it in the fridge and eat it within a day." },
  { id: 38, text: "Defrost food in the fridge rather than on the worktop, and allow plenty of time for larger items." },
  { id: 39, text: "Reheat leftovers until they are steaming hot all the way through, and reheat them only once." },
  { id: 40, text: "Stir food halfway through microwaving. Microwaves heat unevenly and stirring gets rid of the cold spots." },

  // Using things up
  { id: 41, text: "Blitz stale bread into breadcrumbs and freeze them. They are ready for toppings, coatings and meatballs." },
  { id: 42, text: "Save Parmesan rinds and simmer one in soup or stew for extra flavour. Fish it out before serving." },
  { id: 43, text: "Keep a bag in the freezer for onion ends, carrot peel and herb stalks. When it is full, simmer it into stock." },
  { id: 44, text: "Peel overripe bananas and freeze them. They are perfect for smoothies and banana bread." },
  { id: 45, text: "Chop leftover soft herbs, pack them into an ice cube tray, cover with oil and freeze. Drop a cube into the pan next time." },
  { id: 46, text: "Spinach looking tired? Wilt it into a curry, soup or pasta sauce, where nobody will notice." },
  { id: 47, text: "Leftover cooked vegetables, potatoes or pasta make a quick frittata with a few eggs." },
  { id: 48, text: "After a roast chicken, simmer the carcass with an onion and a carrot for an easy stock." },
  { id: 49, text: "Cooking double and freezing half takes little extra effort and gives you a ready meal for a busy night." },
  { id: 50, text: "Look in the fridge and cupboards before you write your shopping list. It is the easiest way to avoid buying doubles." },
  { id: 51, text: "Plan this week's first meals around whatever needs using up soonest." },
  { id: 52, text: "Egg whites freeze well. Write the number of whites on the tub so you know what you have." },
  { id: 53, text: "The liquid from a tin of chickpeas whips up like egg white. Try it in meringues or mousse." },

  // Prep and cooking
  { id: 54, text: "Put a damp cloth under your chopping board to stop it sliding around while you cut." },
  { id: 55, text: "A sharp knife is safer than a blunt one. It needs less force, so it is less likely to slip." },
  { id: 56, text: "Save a mug of pasta water before you drain. A splash helps the sauce cling to the pasta." },
  { id: 57, text: "Pat meat and fish dry with kitchen paper before frying. Dry surfaces brown, wet ones steam." },
  { id: 58, text: "Do not crowd the pan. Give food space and it browns. Pile it in and it steams." },
  { id: 59, text: "Let meat rest for a few minutes after cooking. It stays juicier when you cut it." },
  { id: 60, text: "Read the whole recipe before you start, and get your ingredients out first. Cooking goes much more smoothly." },
  { id: 61, text: "Taste as you cook and adjust the seasoning at the end." },
  { id: 62, text: "Dish tastes flat? A squeeze of lemon or a small splash of vinegar often lifts it more than extra salt." },
  { id: 63, text: "Soup or stew too salty? Add more water, stock or unsalted vegetables to dilute it." },
  { id: 64, text: "Peel ginger with the edge of a teaspoon. It follows the knobbly bits and wastes far less than a knife." },
  { id: 65, text: "Press a garlic clove under the flat of a knife and the skin slips straight off." },
  { id: 66, text: "Bit of eggshell in the bowl? Scoop it out with half of the eggshell. It works better than a spoon." },
  { id: 67, text: "Older eggs are easier to peel when hard-boiled than very fresh ones." },
  { id: 68, text: "Roll a lemon firmly on the worktop before cutting it and you will get more juice out." },
  { id: 69, text: "Add dried herbs early so they have time to soften. Add soft fresh herbs at the very end." },
  { id: 70, text: "Rinse rice until the water runs mostly clear for fluffier, less sticky grains." },
  { id: 71, text: "Lightly oil the spoon before measuring honey or syrup and it will slide right off." },
  { id: 72, text: "Need soft butter in a hurry? Grate it and it will be spreadable in a few minutes." },
  { id: 73, text: "For baking, weigh ingredients rather than using cups. The results are far more consistent." },
  { id: 74, text: "Get the pan hot before the food goes in. Food is less likely to stick and it browns better." },

  // Saving energy
  { id: 75, text: "Put a lid on the pan. Water comes to the boil faster and you use less energy." },
  { id: 76, text: "Fill the kettle with only as much water as you need." },
  { id: 77, text: "If the oven is on anyway, use the spare shelf: roast some vegetables or bake potatoes for tomorrow." },

  // Hygiene and cleaning
  { id: 78, text: "Do not wash raw chicken. Splashing water can spread bacteria around the sink and worktop. Cooking it thoroughly is what matters." },
  { id: 79, text: "Use a separate chopping board for raw meat, or wash the board well with hot soapy water before anything else touches it." },
  { id: 80, text: "Chopping board smells of garlic or onion? Rub it with half a lemon and a little salt, then rinse." },
  { id: 81, text: "To descale a kettle, fill it with half water and half white vinegar, leave it for an hour, then rinse well and boil fresh water once." },
  { id: 82, text: "To loosen a dirty microwave, heat a bowl of water with lemon slices for a few minutes, then wipe it clean." },
  { id: 83, text: "Burnt-on pan? Fill it with hot water and a spoonful of bicarbonate of soda, and leave it to soak before scrubbing." },
  { id: 84, text: "Wash wooden spoons and boards by hand and dry them straight away. Soaking and dishwashers make them crack." },
  { id: 85, text: "Use wooden or silicone utensils in non-stick pans. Metal scratches the coating." },
];

export const TIPS_PER_DAY = 3;

/** Today's date in the UK as YYYY-MM-DD (Home already uses Europe/London for its date line). */
export function londonDateKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Small deterministic PRNG (mulberry32) so the daily pick is the same on every server and device. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The three tips for a UK date. The pool is shuffled once per cycle (pool size / 3 days) and each
 * day takes the next three, so no tip repeats until the whole pool has been shown.
 */
export function tipsForDay(dateKey: string, pool: readonly KitchenTip[] = KITCHEN_TIPS): KitchenTip[] {
  const perDay = Math.min(TIPS_PER_DAY, pool.length);
  if (perDay === 0) return [];
  const [y, m, d] = dateKey.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
  const daysPerCycle = Math.max(1, Math.floor(pool.length / perDay));
  const cycle = Math.floor(dayNumber / daysPerCycle);
  const slot = ((dayNumber % daysPerCycle) + daysPerCycle) % daysPerCycle;

  const shuffled = [...pool];
  const rand = mulberry32(cycle * 2654435761 + 97);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(slot * perDay, slot * perDay + perDay);
}
