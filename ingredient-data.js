// -------------------------------------------------------------
// The big built-in ingredient list, used for two things:
//
// 1. SUGGESTIONS - every name in here (on both sides of the alias
//    list, plus the extra names at the bottom) shows up in the
//    Ingredient Name / Item Name dropdowns as you type.
//
// 2. ALIASES - most recipes online are American, and call things
//    by different names to what Pak'nSave / Woolworths NZ put on
//    the shelf (cilantro vs coriander, ground beef vs mince...).
//    Each line below says "a recipe calling for THIS should count
//    as THAT", so a recipe asking for "Ground beef" is happy with
//    the "Mince" in the fridge.
//
// This is CODE, not data - it lives in GitHub and gets pulled to
// the garage server like any other file. Aliases you add yourself
// still go in ingredient_aliases.csv on the garage, and if the same
// name is in both, YOURS wins.
//
// Matching ignores capitals, plurals ("Onions" = "Onion"), hyphens
// and apostrophes ("All-Purpose" = "All Purpose"), so there's no
// need to add every spelling of the same thing - see
// normalizeIngredientName() in server.js.
//
// The name on the right should be what you'd actually call it in
// the pantry. Aliases can chain: if "Gravy Beef" -> "Stewing Beef"
// here, and you add "Stewing Beef" -> "Beef" yourself, a recipe
// asking for gravy beef will match "Beef" in the pantry.
// -------------------------------------------------------------

const BUILT_IN_ALIASES = {

    // ---- Beef, lamb, pork ----
    'Ground Beef': 'Mince',
    'Ground Chuck': 'Mince',
    'Lean Ground Beef': 'Mince',
    'Hamburger Meat': 'Mince',
    'Ground Pork': 'Mince',
    'Ground Lamb': 'Mince',
    'Ground Turkey': 'Mince',
    'Ground Chicken': 'Mince',
    'Beef Mince': 'Mince',
    'Lamb Mince': 'Mince',
    'Pork Mince': 'Mince',
    'Chicken Mince': 'Mince',
    'Beef Stew Meat': 'Stewing Beef',
    'Stew Meat': 'Stewing Beef',
    'Chuck Steak': 'Stewing Beef',
    'Gravy Beef': 'Stewing Beef',
    'Diced Beef': 'Stewing Beef',
    'Ribeye Steak': 'Scotch Fillet',
    'Rib Eye Steak': 'Scotch Fillet',
    'Beef Tenderloin': 'Eye Fillet',
    'Filet Mignon': 'Eye Fillet',
    'New York Strip Steak': 'Sirloin Steak',
    'Strip Steak': 'Sirloin Steak',
    'Top Sirloin': 'Sirloin Steak',
    'Flank Steak': 'Beef Stir Fry Strips',
    'Beef Strips': 'Beef Stir Fry Strips',
    'Lamb Leg': 'Leg of Lamb',
    'Pork Tenderloin': 'Pork Fillet',
    'Pork Butt': 'Pork Shoulder',
    'Boston Butt': 'Pork Shoulder',

    // ---- Chicken ----
    'Boneless Skinless Chicken Breast': 'Chicken Breast',
    'Skinless Chicken Breast': 'Chicken Breast',
    'Chicken Breast Fillet': 'Chicken Breast',
    'Chicken Breast Tenderloin': 'Chicken Breast',
    'Chicken Tenderloin': 'Chicken Breast',
    'Chicken Tender': 'Chicken Breast',
    'Boneless Skinless Chicken Thigh': 'Chicken Thigh',
    'Boneless Chicken Thigh': 'Chicken Thigh',
    'Chicken Thigh Fillet': 'Chicken Thigh',
    'Bone In Chicken Thigh': 'Chicken Thigh',
    'Chicken Leg': 'Chicken Drumsticks',
    'Rotisserie Chicken': 'Roast Chicken',

    // ---- Bacon, ham, sausages ----
    'Bacon Strip': 'Bacon',
    'Bacon Slice': 'Bacon',
    'Thick Cut Bacon': 'Bacon',
    'Streaky Bacon': 'Bacon',
    'Middle Bacon': 'Bacon',
    'Bacon Rasher': 'Bacon',
    'Canadian Bacon': 'Ham',
    'Deli Ham': 'Ham',
    'Smoked Ham': 'Ham',
    'Sliced Ham': 'Ham',
    'Italian Sausage': 'Sausages',
    'Breakfast Sausage': 'Sausages',
    'Beef Sausage': 'Sausages',
    'Pork Sausage': 'Sausages',
    'Chicken Sausage': 'Sausages',
    'Hot Dog': 'Sausages',
    'Frankfurter': 'Sausages',
    'Cheerio': 'Sausages',
    'Saveloy': 'Sausages',
    'Kielbasa': 'Smoked Sausage',
    'Chorizo Sausage': 'Chorizo',
    'Pepperoni Slice': 'Pepperoni',

    // ---- Seafood ----
    'Shrimp': 'Prawns',
    'Jumbo Shrimp': 'Prawns',
    'Raw Shrimp': 'Prawns',
    'Cooked Shrimp': 'Prawns',
    'King Prawn': 'Prawns',
    'Cod': 'White Fish',
    'Cod Fillet': 'White Fish',
    'Tilapia': 'White Fish',
    'Haddock': 'White Fish',
    'Halibut': 'White Fish',
    'Hoki': 'White Fish',
    'Tarakihi': 'White Fish',
    'Basa': 'White Fish',
    'White Fish Fillet': 'White Fish',
    'Salmon Fillet': 'Salmon',
    'Canned Salmon': 'Tinned Salmon',
    'Canned Tuna': 'Tuna',
    'Tuna In Brine': 'Tuna',
    'Tuna In Water': 'Tuna',
    'Tuna In Oil': 'Tuna',
    'Tinned Tuna': 'Tuna',

    // ---- Onions, garlic, ginger ----
    'Yellow Onion': 'Onion',
    'Brown Onion': 'Onion',
    'White Onion': 'Onion',
    'Red Onion': 'Onion',
    'Sweet Onion': 'Onion',
    'Vidalia Onion': 'Onion',
    'Spanish Onion': 'Onion',
    'Shallot': 'Onion',
    'Scallion': 'Spring Onions',
    'Green Onion': 'Spring Onions',
    'Garlic Clove': 'Garlic',
    'Clove Garlic': 'Garlic',
    'Cloves Of Garlic': 'Garlic',
    'Crushed Garlic': 'Garlic',
    'Minced Garlic': 'Garlic',
    'Garlic Bulb': 'Garlic',
    'Fresh Ginger': 'Ginger',
    'Ginger Root': 'Ginger',
    'Minced Ginger': 'Ginger',
    'Crushed Ginger': 'Ginger',

    // ---- Vegetables ----
    'Zucchini': 'Courgette',
    'Aubergine': 'Eggplant',
    'Arugula': 'Rocket',
    'Rutabaga': 'Swede',
    'Sweet Potato': 'Kumara',
    'Yam': 'Kumara',
    'Russet Potato': 'Potato',
    'Yukon Gold Potato': 'Potato',
    'Red Potato': 'Potato',
    'Baby Potato': 'Potato',
    'Agria Potato': 'Potato',
    'Washed Potato': 'Potato',
    'Baby Carrot': 'Carrot',
    'Celery Stalk': 'Celery',
    'Celery Rib': 'Celery',
    'Bell Pepper': 'Capsicum',
    'Red Bell Pepper': 'Capsicum',
    'Green Bell Pepper': 'Capsicum',
    'Yellow Bell Pepper': 'Capsicum',
    'Orange Bell Pepper': 'Capsicum',
    'Red Capsicum': 'Capsicum',
    'Green Capsicum': 'Capsicum',
    'Yellow Capsicum': 'Capsicum',
    'Broccoli Floret': 'Broccoli',
    'Broccoli Crown': 'Broccoli',
    'Broccoli Head': 'Broccoli',
    'Cauliflower Floret': 'Cauliflower',
    'Baby Spinach': 'Spinach',
    'Fresh Spinach': 'Spinach',
    'Frozen Spinach': 'Spinach',
    'Romaine Lettuce': 'Lettuce',
    'Romaine': 'Lettuce',
    'Cos Lettuce': 'Lettuce',
    'Iceberg Lettuce': 'Lettuce',
    'Butter Lettuce': 'Lettuce',
    'Mixed Greens': 'Salad Leaves',
    'Spring Mix': 'Salad Leaves',
    'Mesclun': 'Salad Leaves',
    'Green Cabbage': 'Cabbage',
    'Savoy Cabbage': 'Cabbage',
    'Button Mushroom': 'Mushrooms',
    'White Mushroom': 'Mushrooms',
    'Cremini Mushroom': 'Mushrooms',
    'Brown Mushroom': 'Mushrooms',
    'Portobello Mushroom': 'Mushrooms',
    'Roma Tomato': 'Tomatoes',
    'Plum Tomato': 'Tomatoes',
    'Vine Tomato': 'Tomatoes',
    'Fresh Tomato': 'Tomatoes',
    'Grape Tomato': 'Cherry Tomatoes',
    'Butternut Squash': 'Butternut Pumpkin',
    'Butternut': 'Butternut Pumpkin',
    'Acorn Squash': 'Pumpkin',
    'Kabocha Squash': 'Pumpkin',
    'Crown Pumpkin': 'Pumpkin',
    'Sugar Snap Pea': 'Snow Peas',
    'String Bean': 'Green Beans',
    'Frozen Pea': 'Peas',
    'Green Pea': 'Peas',
    'Baby Pea': 'Peas',
    'Corn Kernel': 'Corn',
    'Whole Kernel Corn': 'Corn',
    'Sweetcorn': 'Corn',
    'Sweet Corn': 'Corn',
    'Canned Corn': 'Corn',
    'Frozen Corn': 'Corn',
    'Corn On The Cob': 'Corn Cobs',
    'Ear Of Corn': 'Corn Cobs',
    'Mixed Vegetables': 'Mixed Vege',
    'Frozen Mixed Vegetables': 'Mixed Vege',
    'Mixed Veg': 'Mixed Vege',
    'Mixed Veggies': 'Mixed Vege',
    'Stir Fry Vegetables': 'Stir Fry Vege',
    'Jalapeno Pepper': 'Jalapenos',
    'Chili Pepper': 'Chilli',
    'Chile Pepper': 'Chilli',
    'Red Chili': 'Chilli',
    'Fresh Chili': 'Chilli',
    'Thai Chili': 'Chilli',

    // ---- Fresh herbs ----
    'Cilantro': 'Coriander',
    'Fresh Cilantro': 'Coriander',
    'Fresh Coriander': 'Coriander',
    'Italian Parsley': 'Parsley',
    'Flat Leaf Parsley': 'Parsley',
    'Curly Parsley': 'Parsley',
    'Fresh Parsley': 'Parsley',
    'Fresh Basil': 'Basil',
    'Basil Leaves': 'Basil',
    'Fresh Thyme': 'Thyme',
    'Thyme Sprig': 'Thyme',
    'Fresh Rosemary': 'Rosemary',
    'Rosemary Sprig': 'Rosemary',
    'Sage Leaf': 'Sage',
    'Fresh Sage': 'Sage',
    'Fresh Mint': 'Mint',
    'Mint Leaves': 'Mint',
    'Fresh Dill': 'Dill',
    'Fresh Chives': 'Chives',

    // ---- Fruit ----
    'Granny Smith Apple': 'Apples',
    'Navel Orange': 'Oranges',
    'Hass Avocado': 'Avocados',
    'Fresh Blueberries': 'Blueberries',
    'Frozen Blueberries': 'Blueberries',
    'Fresh Strawberries': 'Strawberries',
    'Frozen Berries': 'Mixed Berries',
    'Canned Pineapple': 'Pineapple',
    'Pineapple Chunks': 'Pineapple',
    'Golden Raisins': 'Sultanas',

    // ---- Dairy & eggs ----
    'Heavy Cream': 'Cream',
    'Heavy Whipping Cream': 'Cream',
    'Whipping Cream': 'Cream',
    'Double Cream': 'Cream',
    'Light Cream': 'Cream',
    'Half And Half': 'Cream',
    'Thickened Cream': 'Cream',
    'Pouring Cream': 'Cream',
    'Fresh Cream': 'Cream',
    'Whole Milk': 'Milk',
    '2% Milk': 'Milk',
    'Skim Milk': 'Milk',
    'Trim Milk': 'Milk',
    'Lite Milk': 'Milk',
    'Full Cream Milk': 'Milk',
    'Standard Milk': 'Milk',
    'Blue Top Milk': 'Milk',
    'Unsalted Butter': 'Butter',
    'Salted Butter': 'Butter',
    'Block Butter': 'Butter',
    'Stick Of Butter': 'Butter',
    'Cheddar': 'Cheese',
    'Cheddar Cheese': 'Cheese',
    'Sharp Cheddar': 'Cheese',
    'Sharp Cheddar Cheese': 'Cheese',
    'Mild Cheddar': 'Cheese',
    'Shredded Cheese': 'Cheese',
    'Shredded Cheddar': 'Cheese',
    'Grated Cheese': 'Cheese',
    'Tasty Cheese': 'Cheese',
    'Colby Cheese': 'Cheese',
    'Edam Cheese': 'Cheese',
    'Mild Cheese': 'Cheese',
    'Monterey Jack': 'Cheese',
    'Monterey Jack Cheese': 'Cheese',
    'Colby Jack': 'Cheese',
    'Mexican Blend Cheese': 'Cheese',
    'American Cheese': 'Cheese Slices',
    'Shredded Mozzarella': 'Mozzarella',
    'Mozzarella Cheese': 'Mozzarella',
    'Fresh Mozzarella': 'Mozzarella',
    'Parmesan Cheese': 'Parmesan',
    'Grated Parmesan': 'Parmesan',
    'Shaved Parmesan': 'Parmesan',
    'Parmigiano Reggiano': 'Parmesan',
    'Feta Cheese': 'Feta',
    'Ricotta Cheese': 'Ricotta',
    'Plain Yogurt': 'Yoghurt',
    'Greek Yogurt': 'Yoghurt',
    'Yogurt': 'Yoghurt',
    'Natural Yoghurt': 'Yoghurt',
    'Greek Yoghurt': 'Yoghurt',
    'Large Egg': 'Eggs',
    'Free Range Egg': 'Eggs',
    'Barn Egg': 'Eggs',
    'Egg Yolk': 'Eggs',
    'Egg White': 'Eggs',

    // ---- Baking ----
    'All Purpose Flour': 'Flour',
    'AP Flour': 'Flour',
    'Plain Flour': 'Flour',
    'Standard Flour': 'Flour',
    'White Flour': 'Flour',
    'Cake Flour': 'Flour',
    'Self Rising Flour': 'Self Raising Flour',
    'Bread Flour': 'High Grade Flour',
    'Whole Wheat Flour': 'Wholemeal Flour',
    'Cornstarch': 'Cornflour',
    'Corn Starch': 'Cornflour',
    'Bicarbonate Of Soda': 'Baking Soda',
    'Bicarb Soda': 'Baking Soda',
    'Granulated Sugar': 'Sugar',
    'White Sugar': 'Sugar',
    'Caster Sugar': 'Sugar',
    'Superfine Sugar': 'Sugar',
    'Powdered Sugar': 'Icing Sugar',
    'Confectioners Sugar': 'Icing Sugar',
    'Light Brown Sugar': 'Brown Sugar',
    'Dark Brown Sugar': 'Brown Sugar',
    'Packed Brown Sugar': 'Brown Sugar',
    'Soft Brown Sugar': 'Brown Sugar',
    'Vanilla Extract': 'Vanilla Essence',
    'Pure Vanilla Extract': 'Vanilla Essence',
    'Unsweetened Cocoa Powder': 'Cocoa',
    'Cocoa Powder': 'Cocoa',
    'Semi Sweet Chocolate Chips': 'Chocolate Chips',
    'Dark Chocolate Chips': 'Chocolate Chips',
    'Molasses': 'Treacle',
    'Active Dry Yeast': 'Yeast',
    'Instant Yeast': 'Yeast',
    'Dry Yeast': 'Yeast',
    'Old Fashioned Oats': 'Rolled Oats',
    'Quick Oats': 'Rolled Oats',
    'Oats': 'Rolled Oats',
    'Panko': 'Breadcrumbs',
    'Panko Breadcrumbs': 'Breadcrumbs',
    'Bread Crumbs': 'Breadcrumbs',
    'Dried Breadcrumbs': 'Breadcrumbs',
    'Shredded Coconut': 'Desiccated Coconut',
    'Flaked Coconut': 'Desiccated Coconut',
    'Pie Crust': 'Short Pastry',
    'Pie Dough': 'Short Pastry',
    'Shortcrust Pastry': 'Short Pastry',
    'Puff Pastry Sheet': 'Puff Pastry',
    'Phyllo Dough': 'Filo Pastry',
    'Filo': 'Filo Pastry',

    // ---- Oils & vinegars ----
    'Extra Virgin Olive Oil': 'Olive Oil',
    'EVOO': 'Olive Oil',
    'Light Olive Oil': 'Olive Oil',
    'Canola Oil': 'Vegetable Oil',
    'Rice Bran Oil': 'Vegetable Oil',
    'Sunflower Oil': 'Vegetable Oil',
    'Neutral Oil': 'Vegetable Oil',
    'Cooking Oil': 'Vegetable Oil',
    'Toasted Sesame Oil': 'Sesame Oil',
    'Distilled White Vinegar': 'White Vinegar',
    'ACV': 'Apple Cider Vinegar',

    // ---- Tins, jars & sauces ----
    'Canned Tomatoes': 'Tinned Tomatoes',
    'Canned Diced Tomatoes': 'Tinned Tomatoes',
    'Diced Tomatoes': 'Tinned Tomatoes',
    'Diced Tomatoes In Juice': 'Tinned Tomatoes',
    'Crushed Tomatoes': 'Tinned Tomatoes',
    'Chopped Tomatoes': 'Tinned Tomatoes',
    'Whole Peeled Tomatoes': 'Tinned Tomatoes',
    'Fire Roasted Tomatoes': 'Tinned Tomatoes',
    'San Marzano Tomatoes': 'Tinned Tomatoes',
    'Tomatoes In Juice': 'Tinned Tomatoes',
    'Marinara Sauce': 'Pasta Sauce',
    'Marinara': 'Pasta Sauce',
    'Spaghetti Sauce': 'Pasta Sauce',
    'Napoli Sauce': 'Pasta Sauce',
    'Passata': 'Pasta Sauce',
    'Tomato Passata': 'Pasta Sauce',
    'Tomato Puree': 'Tomato Paste',
    // NOTE: "Tomato Sauce" on its own is deliberately NOT here - in
    // an American recipe it means tinned tomato sauce, but in NZ it
    // means the stuff you put on a pie. Ketchup -> Tomato Sauce is
    // safe though, since that's only ever the pie kind.
    'Ketchup': 'Tomato Sauce',
    'Catsup': 'Tomato Sauce',
    'Mayo': 'Mayonnaise',
    'Yellow Mustard': 'Mustard',
    'American Mustard': 'Mustard',
    'Light Soy Sauce': 'Soy Sauce',
    'Low Sodium Soy Sauce': 'Soy Sauce',
    'Reduced Salt Soy Sauce': 'Soy Sauce',
    'Barbecue Sauce': 'BBQ Sauce',
    'Worcester Sauce': 'Worcestershire Sauce',
    'Hot Sauce': 'Chilli Sauce',
    'Sweet Chili Sauce': 'Sweet Chilli Sauce',
    'Chicken Broth': 'Chicken Stock',
    'Low Sodium Chicken Broth': 'Chicken Stock',
    'Chicken Bouillon': 'Chicken Stock',
    'Beef Broth': 'Beef Stock',
    'Beef Bouillon': 'Beef Stock',
    'Vegetable Broth': 'Vegetable Stock',
    'Bouillon Cube': 'Stock Cubes',
    'Garbanzo Beans': 'Chickpeas',
    'Red Kidney Beans': 'Kidney Beans',
    'Navy Beans': 'Haricot Beans',
    'Great Northern Beans': 'Cannellini Beans',
    'White Beans': 'Cannellini Beans',
    'Red Lentils': 'Lentils',
    'Brown Lentils': 'Lentils',
    'Green Lentils': 'Lentils',
    'Canned Coconut Milk': 'Coconut Milk',
    'Full Fat Coconut Milk': 'Coconut Milk',
    'Apple Cider': 'Apple Juice',
    'Dry White Wine': 'White Wine',
    'Dry Red Wine': 'Red Wine',
    'Chinese Cooking Wine': 'Shaoxing Wine',

    // ---- Pasta, rice, grains ----
    'Spaghetti': 'Pasta',
    'Penne': 'Pasta',
    'Fusilli': 'Pasta',
    'Macaroni': 'Pasta',
    'Elbow Macaroni': 'Pasta',
    'Rigatoni': 'Pasta',
    'Linguine': 'Pasta',
    'Fettuccine': 'Pasta',
    'Angel Hair Pasta': 'Pasta',
    'Farfalle': 'Pasta',
    'Bow Tie Pasta': 'Pasta',
    'Shell Pasta': 'Pasta',
    'Lasagne Sheets': 'Pasta',
    'Lasagna Noodles': 'Pasta',
    'Lasagna Sheets': 'Pasta',
    'Egg Noodles': 'Pasta',
    'Ramen Noodles': 'Instant Noodles',
    'Rice Vermicelli': 'Rice Noodles',
    'Long Grain Rice': 'Rice',
    'Long Grain White Rice': 'Rice',
    'White Rice': 'Rice',
    'Jasmine Rice': 'Rice',
    'Basmati Rice': 'Rice',
    'Brown Rice': 'Rice',
    'Risotto Rice': 'Arborio Rice',

    // ---- Bread & wraps ----
    'Sandwich Bread': 'Bread',
    'White Bread': 'Bread',
    'Sliced Bread': 'Bread',
    'Toast Bread': 'Bread',
    'Hamburger Bun': 'Burger Buns',
    'Hot Dog Bun': 'Hot Dog Rolls',
    'Flour Tortillas': 'Wraps',
    'Tortillas': 'Wraps',
    'Baguette': 'French Stick',
    'Pita': 'Pita Bread',
    'Pitta Bread': 'Pita Bread',

    // ---- Herbs, spices & seasonings ----
    'Kosher Salt': 'Salt',
    'Table Salt': 'Salt',
    'Sea Salt': 'Salt',
    'Iodised Salt': 'Salt',
    'Iodized Salt': 'Salt',
    'Flaky Salt': 'Salt',
    'Black Pepper': 'Pepper',
    'Ground Black Pepper': 'Pepper',
    'Freshly Ground Black Pepper': 'Pepper',
    'Cracked Pepper': 'Pepper',
    'Peppercorns': 'Pepper',
    'Red Pepper Flakes': 'Chilli Flakes',
    'Crushed Red Pepper': 'Chilli Flakes',
    'Crushed Red Pepper Flakes': 'Chilli Flakes',
    'Chili Flakes': 'Chilli Flakes',
    'Chili Powder': 'Chilli Powder',
    'Cayenne': 'Cayenne Pepper',
    'Ground Cayenne Pepper': 'Cayenne Pepper',
    'Ground Cumin': 'Cumin',
    'Cumin Seeds': 'Cumin',
    'Ground Cinnamon': 'Cinnamon',
    'Cinnamon Stick': 'Cinnamon',
    'Ground Nutmeg': 'Nutmeg',
    'Ground Turmeric': 'Turmeric',
    'Sweet Paprika': 'Paprika',
    'Ground Paprika': 'Paprika',
    'Dried Oregano': 'Oregano',
    'Dried Basil': 'Basil',
    'Dried Thyme': 'Thyme',
    'Dried Rosemary': 'Rosemary',
    'Dried Parsley': 'Parsley',
    'Italian Seasoning': 'Mixed Herbs',
    'Dried Mixed Herbs': 'Mixed Herbs',
    'Herbes De Provence': 'Mixed Herbs',
    'Bay Leaf': 'Bay Leaves',
    'Dried Bay Leaves': 'Bay Leaves',
    'Granulated Garlic': 'Garlic Powder',
    'Garlic Granules': 'Garlic Powder',
    'Onion Flakes': 'Onion Powder',
    'Taco Seasoning Mix': 'Taco Seasoning',
    'Cajun Spice': 'Cajun Seasoning',

    // ---- Nuts, seeds & spreads ----
    'Creamy Peanut Butter': 'Peanut Butter',
    'Smooth Peanut Butter': 'Peanut Butter',
    'Crunchy Peanut Butter': 'Peanut Butter',
    'Sliced Almonds': 'Almonds',
    'Slivered Almonds': 'Almonds',
    'Flaked Almonds': 'Almonds',
    'Ground Almonds': 'Almond Meal',
    'Almond Flour': 'Almond Meal',
    'Walnut Halves': 'Walnuts',
    'Chopped Walnuts': 'Walnuts',
    'Pecan Halves': 'Pecans',
    'Toasted Sesame Seeds': 'Sesame Seeds'
};

// -------------------------------------------------------------
// Extra suggestion names that don't need an alias - things that
// are already called the same in a recipe and in the supermarket.
// Everything on BOTH sides of BUILT_IN_ALIASES above is suggested
// too, so there's no need to repeat those names down here.
// -------------------------------------------------------------
const EXTRA_INGREDIENT_NAMES = [
    // Meat & seafood
    'Beef', 'Lamb', 'Pork', 'Chicken', 'Turkey', 'Venison', 'Corned Beef',
    'Beef Schnitzel', 'Rump Steak', 'Lamb Shanks', 'Lamb Shoulder', 'Pork Ribs',
    'Pork Sausages', 'Salami', 'Prosciutto', 'Pancetta', 'Smoked Salmon',
    'Lamb Chops', 'Pork Chops', 'Pork Belly', 'Chicken Wings', 'Whole Chicken',
    'Mussels', 'Squid', 'Scallops', 'Crab', 'Fish Fingers', 'Anchovies', 'Sardines',

    // Vegetables
    'Leeks', 'Asparagus', 'Beetroot', 'Bok Choy', 'Brussels Sprouts', 'Cauliflower',
    'Celery', 'Cucumber', 'Eggplant', 'Fennel', 'Kale', 'Mushrooms',
    'Parsnip', 'Pumpkin', 'Radish', 'Red Cabbage', 'Silverbeet', 'Spinach',
    'Sprouts', 'Watercress', 'Bean Sprouts', 'Artichoke Hearts', 'Olives',
    'Kalamata Olives', 'Sun Dried Tomatoes', 'Roasted Red Peppers',
    'Pickles', 'Gherkins', 'Capers', 'Water Chestnuts', 'Bamboo Shoots',
    'Creamed Corn', 'Frozen Chips', 'Hash Browns', 'Edamame',

    // Fruit
    'Bananas', 'Lemons', 'Limes', 'Raisins', 'Pears', 'Grapes', 'Kiwifruit', 'Mandarins', 'Peaches', 'Plums',
    'Nectarines', 'Apricots', 'Cherries', 'Mango', 'Watermelon', 'Rockmelon',
    'Raspberries', 'Feijoas', 'Passionfruit', 'Dates', 'Dried Apricots',
    'Dried Cranberries', 'Tinned Peaches', 'Tinned Fruit Salad',
    'Lemon Juice', 'Lime Juice', 'Orange Juice', 'Lemon Zest', 'Lime Zest',

    // Dairy & chilled
    'Sour Cream', 'Cream Cheese', 'Cottage Cheese', 'Mascarpone',
    'Halloumi', 'Blue Cheese', 'Brie', 'Camembert', 'Swiss Cheese',
    'Buttermilk', 'Evaporated Milk', 'Sweetened Condensed Milk',
    'Almond Milk', 'Oat Milk', 'Soy Milk', 'Lactose Free Milk', 'Margarine',
    'Custard', 'Tofu', 'Firm Tofu', 'Silken Tofu', 'Fresh Pasta', 'Hummus',

    // Baking & sweet
    'Baking Powder', 'Cream Of Tartar', 'Gelatine', 'Golden Syrup',
    'Maple Syrup', 'Honey', 'Corn Syrup', 'Raw Sugar', 'Food Colouring',
    'Dark Chocolate', 'Milk Chocolate', 'White Chocolate', 'Cooking Chocolate',
    'Sprinkles', 'Marshmallows', 'Gluten Free Flour', 'Rice Flour',
    'Wholemeal Flour', 'Semolina', 'Polenta', 'Cornmeal', 'Chia Seeds',
    'Flaxseed', 'LSA', 'Muesli', 'Weet-Bix', 'Cornflakes', 'Jelly Crystals',
    'Instant Pudding', 'Biscuits', 'Digestive Biscuits', 'Graham Crackers',

    // Pantry, sauces & condiments
    'Fish Sauce', 'Oyster Sauce', 'Hoisin Sauce', 'Teriyaki Sauce',
    'Dark Soy Sauce', 'Kecap Manis', 'Sriracha', 'Tabasco', 'Sambal Oelek',
    'Curry Paste', 'Red Curry Paste', 'Green Curry Paste', 'Massaman Curry Paste',
    'Tikka Masala Paste', 'Butter Chicken Sauce', 'Pesto', 'Basil Pesto',
    'Tahini', 'Miso Paste', 'Gochujang', 'Dijon Mustard', 'Wholegrain Mustard',
    'Horseradish', 'Mint Sauce', 'Relish', 'Chutney', 'Salsa', 'Aioli',
    'Ranch Dressing', 'Caesar Dressing', 'Gravy Granules', 'Gravy Mix',
    'Balsamic Vinegar', 'Red Wine Vinegar', 'White Wine Vinegar',
    'Rice Vinegar', 'Malt Vinegar', 'Coconut Cream', 'Peanut Oil',
    'Cooking Spray', 'Jam', 'Strawberry Jam', 'Marmite', 'Vegemite', 'Nutella',
    'Refried Beans', 'Black Beans', 'Butter Beans', 'Four Bean Mix', 'Spaghetti In A Tin',
    'Tomato Soup', 'Cream Of Mushroom Soup', 'Cream Of Chicken Soup',
    'Beer', 'Cooking Wine', 'Mirin', 'Sake', 'Brandy', 'Rum',

    // Pasta, rice, grains & bread
    'Gluten Free Pasta', 'Gluten Free Bread', 'Gluten Free Wraps',
    'Orzo', 'Tortellini', 'Ravioli', 'Gnocchi', 'Udon Noodles', 'Soba Noodles',
    'Hokkien Noodles', 'Couscous', 'Quinoa', 'Pearl Barley', 'Sushi Rice',
    'Wild Rice', 'Microwave Rice', 'Crackers', 'Rice Crackers', 'Bread Rolls',
    'Naan', 'Garlic Bread', 'English Muffins', 'Crumpets', 'Bagels',
    'Corn Tortillas', 'Taco Shells', 'Corn Chips', 'Potato Chips', 'Pizza Bases',

    // Spices & seasonings
    'Allspice', 'Ground Ginger', 'Cardamom', 'Cloves', 'Coriander Seeds', 'Ground Coriander',
    'Curry Powder', 'Fennel Seeds', 'Five Spice', 'Garam Masala', 'Mustard Seeds',
    'Smoked Paprika', 'Star Anise', 'Sumac', 'Za\'atar', 'Saffron',
    'Mixed Spice', 'Celery Salt', 'Garlic Salt', 'Onion Salt', 'Chicken Salt',
    'Lemon Pepper', 'Steak Seasoning', 'Chinese Five Spice', 'Vanilla Pod',
    'Tarragon', 'Marjoram', 'Lemongrass', 'Kaffir Lime Leaves', 'Curry Leaves',

    // Nuts & seeds
    'Cashews', 'Peanuts', 'Pine Nuts', 'Pistachios', 'Hazelnuts', 'Macadamias',
    'Brazil Nuts', 'Mixed Nuts', 'Pumpkin Seeds', 'Sunflower Seeds',
    'Almond Butter', 'Coconut Flakes',

    // Frozen
    'Frozen Berries', 'Ice Cream', 'Frozen Pizza', 'Frozen Prawns',
    'Frozen Fish Fillets', 'Frozen Dumplings', 'Spring Rolls'
];

// -------------------------------------------------------------
// TINNED GOODS - lets you use "tins" as a unit, both when adding
// stock ("10 tins of tomatoes") and in recipes ("1 tin chickpeas").
// A tin always gets turned into its weight straight away (10 tins
// of tomatoes = 4000 g), so it all adds up with anything entered in
// grams, and the Inventory page shows the tin count next to it.
//
// Anything NOT listed here can still be entered in tins - it just
// counts as DEFAULT_TIN_SIZE (400 g, the standard NZ tin).
// Sizes checked against Pak'nSave / Woolworths NZ (Wattie's, Pams,
// Sealord etc.) - most are 400 g, a few common ones aren't.
//
// "base" is only needed when the tinned name is different from the
// plain one - e.g. "Tin of Tomatoes" should mean Tinned Tomatoes,
// NOT fresh tomatoes.
// -------------------------------------------------------------
const DEFAULT_TIN_SIZE = { quantity: 400, unit: 'g' };

const TINNED_GOODS = [
    { name: 'Tinned Tomatoes', base: 'Tomatoes', quantity: 400, unit: 'g' },
    { name: 'Baked Beans', quantity: 420, unit: 'g' },
    { name: 'Spaghetti In A Tin', base: 'Spaghetti', quantity: 420, unit: 'g' },
    { name: 'Chickpeas', quantity: 400, unit: 'g' },
    { name: 'Kidney Beans', quantity: 400, unit: 'g' },
    { name: 'Black Beans', quantity: 400, unit: 'g' },
    { name: 'Cannellini Beans', quantity: 400, unit: 'g' },
    { name: 'Butter Beans', quantity: 400, unit: 'g' },
    { name: 'Haricot Beans', quantity: 400, unit: 'g' },
    { name: 'Four Bean Mix', quantity: 420, unit: 'g' },
    { name: 'Refried Beans', quantity: 400, unit: 'g' },
    { name: 'Lentils', quantity: 400, unit: 'g' },
    { name: 'Corn', quantity: 410, unit: 'g' },
    { name: 'Creamed Corn', quantity: 410, unit: 'g' },
    { name: 'Beetroot', quantity: 450, unit: 'g' },
    { name: 'Tinned Peaches', base: 'Peaches', quantity: 410, unit: 'g' },
    { name: 'Tinned Fruit Salad', base: 'Fruit Salad', quantity: 410, unit: 'g' },
    { name: 'Tuna', quantity: 185, unit: 'g' },
    { name: 'Tinned Salmon', base: 'Salmon', quantity: 210, unit: 'g' },
    { name: 'Coconut Cream', quantity: 400, unit: 'ml' },
    { name: 'Coconut Milk', quantity: 400, unit: 'ml' },
    { name: 'Evaporated Milk', quantity: 375, unit: 'ml' },
    { name: 'Sweetened Condensed Milk', quantity: 395, unit: 'g' }
];

// -------------------------------------------------------------
// Adds "Tinned X", "Canned X", "Tin of X" and "Can of X" as aliases
// for every tinned good above, so however you word it - "Tin of
// chickpeas", "Canned chickpeas", "Tinned chickpeas" - it all counts
// as the same thing. Anything already in BUILT_IN_ALIASES is left
// exactly as it is.
// -------------------------------------------------------------
const TIN_PREFIXES = ['Tinned', 'Canned', 'Tin Of', 'Tins Of', 'Can Of', 'Cans Of'];

TINNED_GOODS.forEach(good => {
    TIN_PREFIXES.forEach(prefix => {
        const alias = `${prefix} ${good.base || good.name}`;
        if (alias !== good.name && !(alias in BUILT_IN_ALIASES)) {
            BUILT_IN_ALIASES[alias] = good.name;
        }
    });
});

module.exports = { BUILT_IN_ALIASES, EXTRA_INGREDIENT_NAMES, TINNED_GOODS, DEFAULT_TIN_SIZE };
