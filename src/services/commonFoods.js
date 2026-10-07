// ~120 most-logged foods for a calorie tracker.
// Curated for coverage: proteins, carbs, breakfast, dairy, fruit, veg, fats,
// snacks, fast food, drinks. Each entry is a precise FDC search query —
// the importer picks the best Foundation / SR Legacy match.
module.exports = [
  // eggs & dairy
  'egg whole raw', 'egg white raw', 'whole milk', 'skim milk', 'greek yogurt plain',
  'cheddar cheese', 'mozzarella cheese', 'butter', 'cottage cheese',
  // poultry & meat
  'chicken breast grilled', 'chicken thigh', 'turkey breast', 'beef ground 90 lean',
  'beef sirloin steak', 'pork tenderloin', 'bacon pork', 'sausage pork', 'salmon Atlantic',
  'tuna canned in water', 'shrimp', 'tilapia',
  // carbs & grains
  'rice white cooked', 'rice brown cooked', 'pasta spaghetti cooked', 'bread white',
  'bread whole wheat', 'oatmeal cooked', 'oats raw', 'quinoa cooked', 'tortilla flour',
  'bagel plain', 'pancakes', 'cereal corn flakes', 'granola',
  // fruits
  'banana raw', 'apple raw', 'orange raw', 'strawberries raw', 'blueberries raw',
  'grapes raw', 'mango raw', 'pineapple raw', 'watermelon raw', 'avocado raw',
  // vegetables
  'broccoli raw', 'spinach raw', 'carrots raw', 'tomato red raw', 'cucumber raw',
  'lettuce iceberg', 'onion raw', 'potato baked', 'sweet potato baked',
  'corn sweet yellow', 'bell pepper red', 'mushrooms white raw', 'cauliflower raw',
  // legumes & nuts
  'lentils cooked', 'chickpeas cooked', 'black beans cooked', 'kidney beans cooked',
  'peanut butter', 'peanuts', 'almonds', 'walnuts', 'cashews',
  // fats & condiments
  'olive oil', 'coconut oil', 'mayonnaise', 'ketchup', 'honey', 'sugar white',
  // snacks & sweets
  'potato chips', 'chocolate chip cookie', 'donut glazed', 'ice cream vanilla',
  'chocolate dark', 'popcorn air popped', 'pretzels', 'crackers saltine',
  // fast food / restaurant (FNDDS-style)
  'hamburger fast food', 'cheeseburger fast food', 'french fries fast food',
  'pizza cheese', 'fried chicken breast', 'hot dog', 'taco beef', 'burrito bean',
  'sandwich turkey', 'caesar salad with chicken', 'spaghetti with meat sauce',
  // breakfast specifics
  'oatmeal instant', 'scrambled eggs', 'fried egg', 'yogurt strawberry',
  // drinks
  'orange juice', 'apple juice', 'cola soda', 'coffee black', 'tea black',
  'smoothie strawberry banana', 'milk chocolate', 'beer regular', 'wine red',
  // staples & mixed dishes
  'white rice fried', 'chicken curry', 'beef stew', 'vegetable soup',
  'tomato soup', 'ramen noodles', 'sushi salmon roll', 'hummus',
  'peanut butter sandwich', 'grilled cheese sandwich', 'caesar dressing',
  'soy sauce', 'tofu firm', 'protein powder whey vanilla', 'protein bar chocolate',
  'oat milk', 'almond milk unsweetened',
];
