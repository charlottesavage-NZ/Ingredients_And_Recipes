-- =============================================================
-- PHASE 3 UPGRADE - the ingredients table (see docs/database-design.md)
-- =============================================================
-- (Generated from ingredient-data.js - the built-in aliases and tin
-- sizes below are copied from there.)
--
-- Run ONCE in SSMS with the ADMIN login, on the pantry database
-- (right-click pantry -> New Query, so the yellow bar says pantry),
-- with the website stopped (see the README for the full steps).
--
-- One transaction with XACT_ABORT ON: if any part fails, the whole
-- upgrade is rolled back and the phase 2 tables are left exactly as
-- they were. It refuses to run a second time.
--
-- What it does:
-- 1. creates dbo.ingredients - one row per ingredient - from the
--    built-in list (448 names, with tin sizes), your aliases'
--    names, and every name already used in the house / recipes
-- 2. moves the 596 built-in aliases in beside yours (yours win
--    where both have the same alias), each pointing at an ingredient
-- 3. links every stock row, recipe ingredient, minimum and barcode
--    to its ingredient, using the same matching as the website:
--    capitals, plurals ("Onions" = "Onion"), hyphens and apostrophes
--    don't matter, and aliases are followed ("Ground Beef" -> "Mince")
--    - anything that matches nothing becomes a new ingredient
-- 4. rebuilds those tables with the new ingredient_name column (the
--    names as typed are kept exactly as they were)
--
-- Statements that touch the REBUILT tables run through EXEC(...), so
-- SQL Server only checks them once those tables exist.
-- =============================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID('dbo.ingredients', 'U') IS NOT NULL
BEGIN
    RAISERROR('This database already has the ingredients table - nothing was changed.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('dbo.people', 'U') IS NULL OR OBJECT_ID('dbo.inventory', 'U') IS NULL
BEGIN
    RAISERROR('The phase 2 tables were not found - check the yellow bar / database dropdown says pantry. Nothing was changed.', 16, 1);
    RETURN;
END;

BEGIN TRANSACTION;

-- -------------------------------------------------------------
-- 1. The built-in data, from ingredient-data.js
-- -------------------------------------------------------------
CREATE TABLE #builtin_alias (
    alias           NVARCHAR(200) COLLATE DATABASE_DEFAULT,
    ingredient_name NVARCHAR(200) COLLATE DATABASE_DEFAULT
);
INSERT INTO #builtin_alias (alias, ingredient_name) VALUES
    (N'Ground Beef', N'Mince'),
    (N'Ground Chuck', N'Mince'),
    (N'Lean Ground Beef', N'Mince'),
    (N'Hamburger Meat', N'Mince'),
    (N'Ground Pork', N'Mince'),
    (N'Ground Lamb', N'Mince'),
    (N'Ground Turkey', N'Mince'),
    (N'Ground Chicken', N'Mince'),
    (N'Beef Mince', N'Mince'),
    (N'Lamb Mince', N'Mince'),
    (N'Pork Mince', N'Mince'),
    (N'Chicken Mince', N'Mince'),
    (N'Beef Stew Meat', N'Stewing Beef'),
    (N'Stew Meat', N'Stewing Beef'),
    (N'Chuck Steak', N'Stewing Beef'),
    (N'Gravy Beef', N'Stewing Beef'),
    (N'Diced Beef', N'Stewing Beef'),
    (N'Ribeye Steak', N'Scotch Fillet'),
    (N'Rib Eye Steak', N'Scotch Fillet'),
    (N'Beef Tenderloin', N'Eye Fillet'),
    (N'Filet Mignon', N'Eye Fillet'),
    (N'New York Strip Steak', N'Sirloin Steak'),
    (N'Strip Steak', N'Sirloin Steak'),
    (N'Top Sirloin', N'Sirloin Steak'),
    (N'Flank Steak', N'Beef Stir Fry Strips'),
    (N'Beef Strips', N'Beef Stir Fry Strips'),
    (N'Lamb Leg', N'Leg of Lamb'),
    (N'Pork Tenderloin', N'Pork Fillet'),
    (N'Pork Butt', N'Pork Shoulder'),
    (N'Boston Butt', N'Pork Shoulder'),
    (N'Boneless Skinless Chicken Breast', N'Chicken Breast'),
    (N'Skinless Chicken Breast', N'Chicken Breast'),
    (N'Chicken Breast Fillet', N'Chicken Breast'),
    (N'Chicken Breast Tenderloin', N'Chicken Breast'),
    (N'Chicken Tenderloin', N'Chicken Breast'),
    (N'Chicken Tender', N'Chicken Breast'),
    (N'Boneless Skinless Chicken Thigh', N'Chicken Thigh'),
    (N'Boneless Chicken Thigh', N'Chicken Thigh'),
    (N'Chicken Thigh Fillet', N'Chicken Thigh'),
    (N'Bone In Chicken Thigh', N'Chicken Thigh'),
    (N'Chicken Leg', N'Chicken Drumsticks'),
    (N'Rotisserie Chicken', N'Roast Chicken'),
    (N'Bacon Strip', N'Bacon'),
    (N'Bacon Slice', N'Bacon'),
    (N'Thick Cut Bacon', N'Bacon'),
    (N'Streaky Bacon', N'Bacon'),
    (N'Middle Bacon', N'Bacon'),
    (N'Bacon Rasher', N'Bacon'),
    (N'Canadian Bacon', N'Ham'),
    (N'Deli Ham', N'Ham'),
    (N'Smoked Ham', N'Ham'),
    (N'Sliced Ham', N'Ham'),
    (N'Italian Sausage', N'Sausages'),
    (N'Breakfast Sausage', N'Sausages'),
    (N'Beef Sausage', N'Sausages'),
    (N'Pork Sausage', N'Sausages'),
    (N'Chicken Sausage', N'Sausages'),
    (N'Hot Dog', N'Sausages'),
    (N'Frankfurter', N'Sausages'),
    (N'Cheerio', N'Sausages'),
    (N'Saveloy', N'Sausages'),
    (N'Kielbasa', N'Smoked Sausage'),
    (N'Chorizo Sausage', N'Chorizo'),
    (N'Pepperoni Slice', N'Pepperoni'),
    (N'Shrimp', N'Prawns'),
    (N'Jumbo Shrimp', N'Prawns'),
    (N'Raw Shrimp', N'Prawns'),
    (N'Cooked Shrimp', N'Prawns'),
    (N'King Prawn', N'Prawns'),
    (N'Cod', N'White Fish'),
    (N'Cod Fillet', N'White Fish'),
    (N'Tilapia', N'White Fish'),
    (N'Haddock', N'White Fish'),
    (N'Halibut', N'White Fish'),
    (N'Hoki', N'White Fish'),
    (N'Tarakihi', N'White Fish'),
    (N'Basa', N'White Fish'),
    (N'White Fish Fillet', N'White Fish'),
    (N'Salmon Fillet', N'Salmon'),
    (N'Canned Salmon', N'Tinned Salmon'),
    (N'Canned Tuna', N'Tuna'),
    (N'Tuna In Brine', N'Tuna'),
    (N'Tuna In Water', N'Tuna'),
    (N'Tuna In Oil', N'Tuna'),
    (N'Tinned Tuna', N'Tuna'),
    (N'Yellow Onion', N'Onion'),
    (N'Brown Onion', N'Onion'),
    (N'White Onion', N'Onion'),
    (N'Red Onion', N'Onion'),
    (N'Sweet Onion', N'Onion'),
    (N'Vidalia Onion', N'Onion'),
    (N'Spanish Onion', N'Onion'),
    (N'Shallot', N'Onion'),
    (N'Scallion', N'Spring Onions'),
    (N'Green Onion', N'Spring Onions'),
    (N'Garlic Clove', N'Garlic'),
    (N'Clove Garlic', N'Garlic'),
    (N'Cloves Of Garlic', N'Garlic'),
    (N'Crushed Garlic', N'Garlic'),
    (N'Minced Garlic', N'Garlic'),
    (N'Garlic Bulb', N'Garlic'),
    (N'Fresh Ginger', N'Ginger'),
    (N'Ginger Root', N'Ginger'),
    (N'Minced Ginger', N'Ginger'),
    (N'Crushed Ginger', N'Ginger'),
    (N'Zucchini', N'Courgette'),
    (N'Aubergine', N'Eggplant'),
    (N'Arugula', N'Rocket'),
    (N'Rutabaga', N'Swede'),
    (N'Sweet Potato', N'Kumara'),
    (N'Yam', N'Kumara'),
    (N'Russet Potato', N'Potato'),
    (N'Yukon Gold Potato', N'Potato'),
    (N'Red Potato', N'Potato'),
    (N'Baby Potato', N'Potato'),
    (N'Agria Potato', N'Potato'),
    (N'Washed Potato', N'Potato'),
    (N'Baby Carrot', N'Carrot'),
    (N'Celery Stalk', N'Celery'),
    (N'Celery Rib', N'Celery'),
    (N'Bell Pepper', N'Capsicum'),
    (N'Red Bell Pepper', N'Capsicum'),
    (N'Green Bell Pepper', N'Capsicum'),
    (N'Yellow Bell Pepper', N'Capsicum'),
    (N'Orange Bell Pepper', N'Capsicum'),
    (N'Red Capsicum', N'Capsicum'),
    (N'Green Capsicum', N'Capsicum'),
    (N'Yellow Capsicum', N'Capsicum'),
    (N'Broccoli Floret', N'Broccoli'),
    (N'Broccoli Crown', N'Broccoli'),
    (N'Broccoli Head', N'Broccoli'),
    (N'Cauliflower Floret', N'Cauliflower'),
    (N'Baby Spinach', N'Spinach'),
    (N'Fresh Spinach', N'Spinach'),
    (N'Frozen Spinach', N'Spinach'),
    (N'Romaine Lettuce', N'Lettuce'),
    (N'Romaine', N'Lettuce'),
    (N'Cos Lettuce', N'Lettuce'),
    (N'Iceberg Lettuce', N'Lettuce'),
    (N'Butter Lettuce', N'Lettuce'),
    (N'Mixed Greens', N'Salad Leaves'),
    (N'Spring Mix', N'Salad Leaves'),
    (N'Mesclun', N'Salad Leaves'),
    (N'Green Cabbage', N'Cabbage'),
    (N'Savoy Cabbage', N'Cabbage'),
    (N'Button Mushroom', N'Mushrooms'),
    (N'White Mushroom', N'Mushrooms'),
    (N'Cremini Mushroom', N'Mushrooms'),
    (N'Brown Mushroom', N'Mushrooms'),
    (N'Portobello Mushroom', N'Mushrooms'),
    (N'Roma Tomato', N'Tomatoes'),
    (N'Plum Tomato', N'Tomatoes'),
    (N'Vine Tomato', N'Tomatoes'),
    (N'Fresh Tomato', N'Tomatoes'),
    (N'Grape Tomato', N'Cherry Tomatoes'),
    (N'Butternut Squash', N'Butternut Pumpkin'),
    (N'Butternut', N'Butternut Pumpkin'),
    (N'Acorn Squash', N'Pumpkin'),
    (N'Kabocha Squash', N'Pumpkin'),
    (N'Crown Pumpkin', N'Pumpkin'),
    (N'Sugar Snap Pea', N'Snow Peas'),
    (N'String Bean', N'Green Beans'),
    (N'Frozen Pea', N'Peas'),
    (N'Green Pea', N'Peas'),
    (N'Baby Pea', N'Peas'),
    (N'Corn Kernel', N'Corn'),
    (N'Whole Kernel Corn', N'Corn'),
    (N'Sweetcorn', N'Corn'),
    (N'Sweet Corn', N'Corn'),
    (N'Canned Corn', N'Corn'),
    (N'Frozen Corn', N'Corn'),
    (N'Corn On The Cob', N'Corn Cobs'),
    (N'Ear Of Corn', N'Corn Cobs'),
    (N'Mixed Vegetables', N'Mixed Vege'),
    (N'Frozen Mixed Vegetables', N'Mixed Vege'),
    (N'Mixed Veg', N'Mixed Vege'),
    (N'Mixed Veggies', N'Mixed Vege'),
    (N'Stir Fry Vegetables', N'Stir Fry Vege'),
    (N'Jalapeno Pepper', N'Jalapenos'),
    (N'Chili Pepper', N'Chilli'),
    (N'Chile Pepper', N'Chilli'),
    (N'Red Chili', N'Chilli'),
    (N'Fresh Chili', N'Chilli'),
    (N'Thai Chili', N'Chilli'),
    (N'Cilantro', N'Coriander'),
    (N'Fresh Cilantro', N'Coriander'),
    (N'Fresh Coriander', N'Coriander'),
    (N'Italian Parsley', N'Parsley'),
    (N'Flat Leaf Parsley', N'Parsley'),
    (N'Curly Parsley', N'Parsley'),
    (N'Fresh Parsley', N'Parsley'),
    (N'Fresh Basil', N'Basil'),
    (N'Basil Leaves', N'Basil'),
    (N'Fresh Thyme', N'Thyme'),
    (N'Thyme Sprig', N'Thyme'),
    (N'Fresh Rosemary', N'Rosemary'),
    (N'Rosemary Sprig', N'Rosemary'),
    (N'Sage Leaf', N'Sage'),
    (N'Fresh Sage', N'Sage'),
    (N'Fresh Mint', N'Mint'),
    (N'Mint Leaves', N'Mint'),
    (N'Fresh Dill', N'Dill'),
    (N'Fresh Chives', N'Chives'),
    (N'Granny Smith Apple', N'Apples'),
    (N'Navel Orange', N'Oranges'),
    (N'Hass Avocado', N'Avocados'),
    (N'Fresh Blueberries', N'Blueberries'),
    (N'Frozen Blueberries', N'Blueberries'),
    (N'Fresh Strawberries', N'Strawberries'),
    (N'Frozen Berries', N'Mixed Berries'),
    (N'Canned Pineapple', N'Pineapple'),
    (N'Pineapple Chunks', N'Pineapple'),
    (N'Golden Raisins', N'Sultanas'),
    (N'Heavy Cream', N'Cream'),
    (N'Heavy Whipping Cream', N'Cream'),
    (N'Whipping Cream', N'Cream'),
    (N'Double Cream', N'Cream'),
    (N'Light Cream', N'Cream'),
    (N'Half And Half', N'Cream'),
    (N'Thickened Cream', N'Cream'),
    (N'Pouring Cream', N'Cream'),
    (N'Fresh Cream', N'Cream'),
    (N'Whole Milk', N'Milk'),
    (N'2% Milk', N'Milk'),
    (N'Skim Milk', N'Milk'),
    (N'Trim Milk', N'Milk'),
    (N'Lite Milk', N'Milk'),
    (N'Full Cream Milk', N'Milk'),
    (N'Standard Milk', N'Milk'),
    (N'Blue Top Milk', N'Milk'),
    (N'Unsalted Butter', N'Butter'),
    (N'Salted Butter', N'Butter'),
    (N'Block Butter', N'Butter'),
    (N'Stick Of Butter', N'Butter'),
    (N'Cheddar', N'Cheese'),
    (N'Cheddar Cheese', N'Cheese'),
    (N'Sharp Cheddar', N'Cheese'),
    (N'Sharp Cheddar Cheese', N'Cheese'),
    (N'Mild Cheddar', N'Cheese'),
    (N'Shredded Cheese', N'Cheese'),
    (N'Shredded Cheddar', N'Cheese'),
    (N'Grated Cheese', N'Cheese'),
    (N'Tasty Cheese', N'Cheese'),
    (N'Colby Cheese', N'Cheese'),
    (N'Edam Cheese', N'Cheese'),
    (N'Mild Cheese', N'Cheese'),
    (N'Monterey Jack', N'Cheese'),
    (N'Monterey Jack Cheese', N'Cheese'),
    (N'Colby Jack', N'Cheese'),
    (N'Mexican Blend Cheese', N'Cheese'),
    (N'American Cheese', N'Cheese Slices'),
    (N'Shredded Mozzarella', N'Mozzarella'),
    (N'Mozzarella Cheese', N'Mozzarella'),
    (N'Fresh Mozzarella', N'Mozzarella'),
    (N'Parmesan Cheese', N'Parmesan'),
    (N'Grated Parmesan', N'Parmesan'),
    (N'Shaved Parmesan', N'Parmesan'),
    (N'Parmigiano Reggiano', N'Parmesan'),
    (N'Feta Cheese', N'Feta'),
    (N'Ricotta Cheese', N'Ricotta'),
    (N'Plain Yogurt', N'Yoghurt'),
    (N'Greek Yogurt', N'Yoghurt'),
    (N'Yogurt', N'Yoghurt'),
    (N'Natural Yoghurt', N'Yoghurt'),
    (N'Greek Yoghurt', N'Yoghurt'),
    (N'Large Egg', N'Eggs'),
    (N'Free Range Egg', N'Eggs'),
    (N'Barn Egg', N'Eggs'),
    (N'Egg Yolk', N'Eggs'),
    (N'Egg White', N'Eggs'),
    (N'All Purpose Flour', N'Flour'),
    (N'AP Flour', N'Flour'),
    (N'Plain Flour', N'Flour'),
    (N'Standard Flour', N'Flour'),
    (N'White Flour', N'Flour'),
    (N'Cake Flour', N'Flour'),
    (N'Self Rising Flour', N'Self Raising Flour'),
    (N'Bread Flour', N'High Grade Flour'),
    (N'Whole Wheat Flour', N'Wholemeal Flour'),
    (N'Cornstarch', N'Cornflour'),
    (N'Corn Starch', N'Cornflour'),
    (N'Bicarbonate Of Soda', N'Baking Soda'),
    (N'Bicarb Soda', N'Baking Soda'),
    (N'Granulated Sugar', N'Sugar'),
    (N'White Sugar', N'Sugar'),
    (N'Caster Sugar', N'Sugar'),
    (N'Superfine Sugar', N'Sugar'),
    (N'Powdered Sugar', N'Icing Sugar'),
    (N'Confectioners Sugar', N'Icing Sugar'),
    (N'Light Brown Sugar', N'Brown Sugar'),
    (N'Dark Brown Sugar', N'Brown Sugar'),
    (N'Packed Brown Sugar', N'Brown Sugar'),
    (N'Soft Brown Sugar', N'Brown Sugar'),
    (N'Vanilla Extract', N'Vanilla Essence'),
    (N'Pure Vanilla Extract', N'Vanilla Essence'),
    (N'Unsweetened Cocoa Powder', N'Cocoa'),
    (N'Cocoa Powder', N'Cocoa'),
    (N'Semi Sweet Chocolate Chips', N'Chocolate Chips'),
    (N'Dark Chocolate Chips', N'Chocolate Chips'),
    (N'Molasses', N'Treacle'),
    (N'Active Dry Yeast', N'Yeast'),
    (N'Instant Yeast', N'Yeast'),
    (N'Dry Yeast', N'Yeast'),
    (N'Old Fashioned Oats', N'Rolled Oats'),
    (N'Quick Oats', N'Rolled Oats'),
    (N'Oats', N'Rolled Oats'),
    (N'Panko', N'Breadcrumbs'),
    (N'Panko Breadcrumbs', N'Breadcrumbs'),
    (N'Bread Crumbs', N'Breadcrumbs'),
    (N'Dried Breadcrumbs', N'Breadcrumbs'),
    (N'Shredded Coconut', N'Desiccated Coconut'),
    (N'Flaked Coconut', N'Desiccated Coconut'),
    (N'Pie Crust', N'Short Pastry'),
    (N'Pie Dough', N'Short Pastry'),
    (N'Shortcrust Pastry', N'Short Pastry'),
    (N'Puff Pastry Sheet', N'Puff Pastry'),
    (N'Phyllo Dough', N'Filo Pastry'),
    (N'Filo', N'Filo Pastry'),
    (N'Extra Virgin Olive Oil', N'Olive Oil'),
    (N'EVOO', N'Olive Oil'),
    (N'Light Olive Oil', N'Olive Oil'),
    (N'Canola Oil', N'Vegetable Oil'),
    (N'Rice Bran Oil', N'Vegetable Oil'),
    (N'Sunflower Oil', N'Vegetable Oil'),
    (N'Neutral Oil', N'Vegetable Oil'),
    (N'Cooking Oil', N'Vegetable Oil'),
    (N'Toasted Sesame Oil', N'Sesame Oil'),
    (N'Distilled White Vinegar', N'White Vinegar'),
    (N'ACV', N'Apple Cider Vinegar'),
    (N'Canned Tomatoes', N'Tinned Tomatoes'),
    (N'Canned Diced Tomatoes', N'Tinned Tomatoes'),
    (N'Diced Tomatoes', N'Tinned Tomatoes'),
    (N'Diced Tomatoes In Juice', N'Tinned Tomatoes'),
    (N'Crushed Tomatoes', N'Tinned Tomatoes'),
    (N'Chopped Tomatoes', N'Tinned Tomatoes'),
    (N'Whole Peeled Tomatoes', N'Tinned Tomatoes'),
    (N'Fire Roasted Tomatoes', N'Tinned Tomatoes'),
    (N'San Marzano Tomatoes', N'Tinned Tomatoes'),
    (N'Tomatoes In Juice', N'Tinned Tomatoes'),
    (N'Marinara Sauce', N'Pasta Sauce'),
    (N'Marinara', N'Pasta Sauce'),
    (N'Spaghetti Sauce', N'Pasta Sauce'),
    (N'Napoli Sauce', N'Pasta Sauce'),
    (N'Passata', N'Pasta Sauce'),
    (N'Tomato Passata', N'Pasta Sauce'),
    (N'Tomato Puree', N'Tomato Paste'),
    (N'Ketchup', N'Tomato Sauce'),
    (N'Catsup', N'Tomato Sauce'),
    (N'Mayo', N'Mayonnaise'),
    (N'Yellow Mustard', N'Mustard'),
    (N'American Mustard', N'Mustard'),
    (N'Light Soy Sauce', N'Soy Sauce'),
    (N'Low Sodium Soy Sauce', N'Soy Sauce'),
    (N'Reduced Salt Soy Sauce', N'Soy Sauce'),
    (N'Barbecue Sauce', N'BBQ Sauce'),
    (N'Worcester Sauce', N'Worcestershire Sauce'),
    (N'Hot Sauce', N'Chilli Sauce'),
    (N'Sweet Chili Sauce', N'Sweet Chilli Sauce'),
    (N'Chicken Broth', N'Chicken Stock'),
    (N'Low Sodium Chicken Broth', N'Chicken Stock'),
    (N'Chicken Bouillon', N'Chicken Stock'),
    (N'Beef Broth', N'Beef Stock'),
    (N'Beef Bouillon', N'Beef Stock'),
    (N'Vegetable Broth', N'Vegetable Stock'),
    (N'Bouillon Cube', N'Stock Cubes'),
    (N'Garbanzo Beans', N'Chickpeas'),
    (N'Red Kidney Beans', N'Kidney Beans'),
    (N'Navy Beans', N'Haricot Beans'),
    (N'Great Northern Beans', N'Cannellini Beans'),
    (N'White Beans', N'Cannellini Beans'),
    (N'Red Lentils', N'Lentils'),
    (N'Brown Lentils', N'Lentils'),
    (N'Green Lentils', N'Lentils'),
    (N'Canned Coconut Milk', N'Coconut Milk'),
    (N'Full Fat Coconut Milk', N'Coconut Milk'),
    (N'Apple Cider', N'Apple Juice'),
    (N'Dry White Wine', N'White Wine'),
    (N'Dry Red Wine', N'Red Wine'),
    (N'Chinese Cooking Wine', N'Shaoxing Wine'),
    (N'Spaghetti', N'Pasta'),
    (N'Penne', N'Pasta'),
    (N'Fusilli', N'Pasta'),
    (N'Macaroni', N'Pasta'),
    (N'Elbow Macaroni', N'Pasta'),
    (N'Rigatoni', N'Pasta'),
    (N'Linguine', N'Pasta'),
    (N'Fettuccine', N'Pasta'),
    (N'Angel Hair Pasta', N'Pasta'),
    (N'Farfalle', N'Pasta'),
    (N'Bow Tie Pasta', N'Pasta'),
    (N'Shell Pasta', N'Pasta'),
    (N'Lasagne Sheets', N'Pasta'),
    (N'Lasagna Noodles', N'Pasta'),
    (N'Lasagna Sheets', N'Pasta'),
    (N'Egg Noodles', N'Pasta'),
    (N'Ramen Noodles', N'Instant Noodles'),
    (N'Rice Vermicelli', N'Rice Noodles'),
    (N'Long Grain Rice', N'Rice'),
    (N'Long Grain White Rice', N'Rice'),
    (N'White Rice', N'Rice'),
    (N'Jasmine Rice', N'Rice'),
    (N'Basmati Rice', N'Rice'),
    (N'Brown Rice', N'Rice'),
    (N'Risotto Rice', N'Arborio Rice'),
    (N'Sandwich Bread', N'Bread'),
    (N'White Bread', N'Bread'),
    (N'Sliced Bread', N'Bread'),
    (N'Toast Bread', N'Bread'),
    (N'Hamburger Bun', N'Burger Buns'),
    (N'Hot Dog Bun', N'Hot Dog Rolls'),
    (N'Flour Tortillas', N'Wraps'),
    (N'Tortillas', N'Wraps'),
    (N'Baguette', N'French Stick'),
    (N'Pita', N'Pita Bread'),
    (N'Pitta Bread', N'Pita Bread'),
    (N'Kosher Salt', N'Salt'),
    (N'Table Salt', N'Salt'),
    (N'Sea Salt', N'Salt'),
    (N'Iodised Salt', N'Salt'),
    (N'Iodized Salt', N'Salt'),
    (N'Flaky Salt', N'Salt'),
    (N'Black Pepper', N'Pepper'),
    (N'Ground Black Pepper', N'Pepper'),
    (N'Freshly Ground Black Pepper', N'Pepper'),
    (N'Cracked Pepper', N'Pepper'),
    (N'Peppercorns', N'Pepper'),
    (N'Red Pepper Flakes', N'Chilli Flakes'),
    (N'Crushed Red Pepper', N'Chilli Flakes'),
    (N'Crushed Red Pepper Flakes', N'Chilli Flakes'),
    (N'Chili Flakes', N'Chilli Flakes'),
    (N'Chili Powder', N'Chilli Powder'),
    (N'Cayenne', N'Cayenne Pepper'),
    (N'Ground Cayenne Pepper', N'Cayenne Pepper'),
    (N'Ground Cumin', N'Cumin'),
    (N'Cumin Seeds', N'Cumin'),
    (N'Ground Cinnamon', N'Cinnamon'),
    (N'Cinnamon Stick', N'Cinnamon'),
    (N'Ground Nutmeg', N'Nutmeg'),
    (N'Ground Turmeric', N'Turmeric'),
    (N'Sweet Paprika', N'Paprika'),
    (N'Ground Paprika', N'Paprika'),
    (N'Dried Oregano', N'Oregano'),
    (N'Dried Basil', N'Basil'),
    (N'Dried Thyme', N'Thyme'),
    (N'Dried Rosemary', N'Rosemary'),
    (N'Dried Parsley', N'Parsley'),
    (N'Italian Seasoning', N'Mixed Herbs'),
    (N'Dried Mixed Herbs', N'Mixed Herbs'),
    (N'Herbes De Provence', N'Mixed Herbs'),
    (N'Bay Leaf', N'Bay Leaves'),
    (N'Dried Bay Leaves', N'Bay Leaves'),
    (N'Granulated Garlic', N'Garlic Powder'),
    (N'Garlic Granules', N'Garlic Powder'),
    (N'Onion Flakes', N'Onion Powder'),
    (N'Taco Seasoning Mix', N'Taco Seasoning'),
    (N'Cajun Spice', N'Cajun Seasoning'),
    (N'Creamy Peanut Butter', N'Peanut Butter'),
    (N'Smooth Peanut Butter', N'Peanut Butter'),
    (N'Crunchy Peanut Butter', N'Peanut Butter'),
    (N'Sliced Almonds', N'Almonds'),
    (N'Slivered Almonds', N'Almonds'),
    (N'Flaked Almonds', N'Almonds'),
    (N'Ground Almonds', N'Almond Meal'),
    (N'Almond Flour', N'Almond Meal'),
    (N'Walnut Halves', N'Walnuts'),
    (N'Chopped Walnuts', N'Walnuts'),
    (N'Pecan Halves', N'Pecans'),
    (N'Toasted Sesame Seeds', N'Sesame Seeds'),
    (N'Tin Of Tomatoes', N'Tinned Tomatoes'),
    (N'Tins Of Tomatoes', N'Tinned Tomatoes'),
    (N'Can Of Tomatoes', N'Tinned Tomatoes'),
    (N'Cans Of Tomatoes', N'Tinned Tomatoes'),
    (N'Tinned Baked Beans', N'Baked Beans'),
    (N'Canned Baked Beans', N'Baked Beans'),
    (N'Tin Of Baked Beans', N'Baked Beans'),
    (N'Tins Of Baked Beans', N'Baked Beans'),
    (N'Can Of Baked Beans', N'Baked Beans'),
    (N'Cans Of Baked Beans', N'Baked Beans'),
    (N'Tinned Spaghetti', N'Spaghetti In A Tin'),
    (N'Canned Spaghetti', N'Spaghetti In A Tin'),
    (N'Tin Of Spaghetti', N'Spaghetti In A Tin'),
    (N'Tins Of Spaghetti', N'Spaghetti In A Tin'),
    (N'Can Of Spaghetti', N'Spaghetti In A Tin'),
    (N'Cans Of Spaghetti', N'Spaghetti In A Tin'),
    (N'Tinned Chickpeas', N'Chickpeas'),
    (N'Canned Chickpeas', N'Chickpeas'),
    (N'Tin Of Chickpeas', N'Chickpeas'),
    (N'Tins Of Chickpeas', N'Chickpeas'),
    (N'Can Of Chickpeas', N'Chickpeas'),
    (N'Cans Of Chickpeas', N'Chickpeas'),
    (N'Tinned Kidney Beans', N'Kidney Beans'),
    (N'Canned Kidney Beans', N'Kidney Beans'),
    (N'Tin Of Kidney Beans', N'Kidney Beans'),
    (N'Tins Of Kidney Beans', N'Kidney Beans'),
    (N'Can Of Kidney Beans', N'Kidney Beans'),
    (N'Cans Of Kidney Beans', N'Kidney Beans'),
    (N'Tinned Black Beans', N'Black Beans'),
    (N'Canned Black Beans', N'Black Beans'),
    (N'Tin Of Black Beans', N'Black Beans'),
    (N'Tins Of Black Beans', N'Black Beans'),
    (N'Can Of Black Beans', N'Black Beans'),
    (N'Cans Of Black Beans', N'Black Beans'),
    (N'Tinned Cannellini Beans', N'Cannellini Beans'),
    (N'Canned Cannellini Beans', N'Cannellini Beans'),
    (N'Tin Of Cannellini Beans', N'Cannellini Beans'),
    (N'Tins Of Cannellini Beans', N'Cannellini Beans'),
    (N'Can Of Cannellini Beans', N'Cannellini Beans'),
    (N'Cans Of Cannellini Beans', N'Cannellini Beans'),
    (N'Tinned Butter Beans', N'Butter Beans'),
    (N'Canned Butter Beans', N'Butter Beans'),
    (N'Tin Of Butter Beans', N'Butter Beans'),
    (N'Tins Of Butter Beans', N'Butter Beans'),
    (N'Can Of Butter Beans', N'Butter Beans'),
    (N'Cans Of Butter Beans', N'Butter Beans'),
    (N'Tinned Haricot Beans', N'Haricot Beans'),
    (N'Canned Haricot Beans', N'Haricot Beans'),
    (N'Tin Of Haricot Beans', N'Haricot Beans'),
    (N'Tins Of Haricot Beans', N'Haricot Beans'),
    (N'Can Of Haricot Beans', N'Haricot Beans'),
    (N'Cans Of Haricot Beans', N'Haricot Beans'),
    (N'Tinned Four Bean Mix', N'Four Bean Mix'),
    (N'Canned Four Bean Mix', N'Four Bean Mix'),
    (N'Tin Of Four Bean Mix', N'Four Bean Mix'),
    (N'Tins Of Four Bean Mix', N'Four Bean Mix'),
    (N'Can Of Four Bean Mix', N'Four Bean Mix'),
    (N'Cans Of Four Bean Mix', N'Four Bean Mix'),
    (N'Tinned Refried Beans', N'Refried Beans'),
    (N'Canned Refried Beans', N'Refried Beans'),
    (N'Tin Of Refried Beans', N'Refried Beans'),
    (N'Tins Of Refried Beans', N'Refried Beans'),
    (N'Can Of Refried Beans', N'Refried Beans'),
    (N'Cans Of Refried Beans', N'Refried Beans'),
    (N'Tinned Lentils', N'Lentils'),
    (N'Canned Lentils', N'Lentils'),
    (N'Tin Of Lentils', N'Lentils'),
    (N'Tins Of Lentils', N'Lentils'),
    (N'Can Of Lentils', N'Lentils'),
    (N'Cans Of Lentils', N'Lentils'),
    (N'Tinned Corn', N'Corn'),
    (N'Tin Of Corn', N'Corn'),
    (N'Tins Of Corn', N'Corn'),
    (N'Can Of Corn', N'Corn'),
    (N'Cans Of Corn', N'Corn'),
    (N'Tinned Creamed Corn', N'Creamed Corn'),
    (N'Canned Creamed Corn', N'Creamed Corn'),
    (N'Tin Of Creamed Corn', N'Creamed Corn'),
    (N'Tins Of Creamed Corn', N'Creamed Corn'),
    (N'Can Of Creamed Corn', N'Creamed Corn'),
    (N'Cans Of Creamed Corn', N'Creamed Corn'),
    (N'Tinned Beetroot', N'Beetroot'),
    (N'Canned Beetroot', N'Beetroot'),
    (N'Tin Of Beetroot', N'Beetroot'),
    (N'Tins Of Beetroot', N'Beetroot'),
    (N'Can Of Beetroot', N'Beetroot'),
    (N'Cans Of Beetroot', N'Beetroot'),
    (N'Canned Peaches', N'Tinned Peaches'),
    (N'Tin Of Peaches', N'Tinned Peaches'),
    (N'Tins Of Peaches', N'Tinned Peaches'),
    (N'Can Of Peaches', N'Tinned Peaches'),
    (N'Cans Of Peaches', N'Tinned Peaches'),
    (N'Canned Fruit Salad', N'Tinned Fruit Salad'),
    (N'Tin Of Fruit Salad', N'Tinned Fruit Salad'),
    (N'Tins Of Fruit Salad', N'Tinned Fruit Salad'),
    (N'Can Of Fruit Salad', N'Tinned Fruit Salad'),
    (N'Cans Of Fruit Salad', N'Tinned Fruit Salad'),
    (N'Tin Of Tuna', N'Tuna'),
    (N'Tins Of Tuna', N'Tuna'),
    (N'Can Of Tuna', N'Tuna'),
    (N'Cans Of Tuna', N'Tuna'),
    (N'Tin Of Salmon', N'Tinned Salmon'),
    (N'Tins Of Salmon', N'Tinned Salmon'),
    (N'Can Of Salmon', N'Tinned Salmon'),
    (N'Cans Of Salmon', N'Tinned Salmon'),
    (N'Tinned Coconut Cream', N'Coconut Cream'),
    (N'Canned Coconut Cream', N'Coconut Cream'),
    (N'Tin Of Coconut Cream', N'Coconut Cream'),
    (N'Tins Of Coconut Cream', N'Coconut Cream'),
    (N'Can Of Coconut Cream', N'Coconut Cream'),
    (N'Cans Of Coconut Cream', N'Coconut Cream'),
    (N'Tinned Coconut Milk', N'Coconut Milk'),
    (N'Tin Of Coconut Milk', N'Coconut Milk'),
    (N'Tins Of Coconut Milk', N'Coconut Milk'),
    (N'Can Of Coconut Milk', N'Coconut Milk'),
    (N'Cans Of Coconut Milk', N'Coconut Milk'),
    (N'Tinned Evaporated Milk', N'Evaporated Milk'),
    (N'Canned Evaporated Milk', N'Evaporated Milk'),
    (N'Tin Of Evaporated Milk', N'Evaporated Milk'),
    (N'Tins Of Evaporated Milk', N'Evaporated Milk'),
    (N'Can Of Evaporated Milk', N'Evaporated Milk'),
    (N'Cans Of Evaporated Milk', N'Evaporated Milk'),
    (N'Tinned Sweetened Condensed Milk', N'Sweetened Condensed Milk'),
    (N'Canned Sweetened Condensed Milk', N'Sweetened Condensed Milk'),
    (N'Tin Of Sweetened Condensed Milk', N'Sweetened Condensed Milk'),
    (N'Tins Of Sweetened Condensed Milk', N'Sweetened Condensed Milk'),
    (N'Can Of Sweetened Condensed Milk', N'Sweetened Condensed Milk'),
    (N'Cans Of Sweetened Condensed Milk', N'Sweetened Condensed Milk');

CREATE TABLE #builtin_ingredient (
    ingredient_name NVARCHAR(200) COLLATE DATABASE_DEFAULT,
    tin_quantity    DECIMAL(12,3),
    tin_unit        NVARCHAR(20) COLLATE DATABASE_DEFAULT
);
INSERT INTO #builtin_ingredient (ingredient_name, tin_quantity, tin_unit) VALUES
    (N'Tinned Tomatoes', 400, N'g'),
    (N'Baked Beans', 420, N'g'),
    (N'Spaghetti In A Tin', 420, N'g'),
    (N'Chickpeas', 400, N'g'),
    (N'Kidney Beans', 400, N'g'),
    (N'Black Beans', 400, N'g'),
    (N'Cannellini Beans', 400, N'g'),
    (N'Butter Beans', 400, N'g'),
    (N'Haricot Beans', 400, N'g'),
    (N'Four Bean Mix', 420, N'g'),
    (N'Refried Beans', 400, N'g'),
    (N'Lentils', 400, N'g'),
    (N'Corn', 410, N'g'),
    (N'Creamed Corn', 410, N'g'),
    (N'Beetroot', 450, N'g'),
    (N'Tinned Peaches', 410, N'g'),
    (N'Tinned Fruit Salad', 410, N'g'),
    (N'Tuna', 185, N'g'),
    (N'Tinned Salmon', 210, N'g'),
    (N'Coconut Cream', 400, N'ml'),
    (N'Coconut Milk', 400, N'ml'),
    (N'Evaporated Milk', 375, N'ml'),
    (N'Sweetened Condensed Milk', 395, N'g'),
    (N'Beef', NULL, NULL),
    (N'Lamb', NULL, NULL),
    (N'Pork', NULL, NULL),
    (N'Chicken', NULL, NULL),
    (N'Turkey', NULL, NULL),
    (N'Venison', NULL, NULL),
    (N'Corned Beef', NULL, NULL),
    (N'Beef Schnitzel', NULL, NULL),
    (N'Rump Steak', NULL, NULL),
    (N'Lamb Shanks', NULL, NULL),
    (N'Lamb Shoulder', NULL, NULL),
    (N'Pork Ribs', NULL, NULL),
    (N'Pork Sausages', NULL, NULL),
    (N'Salami', NULL, NULL),
    (N'Prosciutto', NULL, NULL),
    (N'Pancetta', NULL, NULL),
    (N'Smoked Salmon', NULL, NULL),
    (N'Lamb Chops', NULL, NULL),
    (N'Pork Chops', NULL, NULL),
    (N'Pork Belly', NULL, NULL),
    (N'Chicken Wings', NULL, NULL),
    (N'Whole Chicken', NULL, NULL),
    (N'Mussels', NULL, NULL),
    (N'Squid', NULL, NULL),
    (N'Scallops', NULL, NULL),
    (N'Crab', NULL, NULL),
    (N'Fish Fingers', NULL, NULL),
    (N'Anchovies', NULL, NULL),
    (N'Sardines', NULL, NULL),
    (N'Leeks', NULL, NULL),
    (N'Asparagus', NULL, NULL),
    (N'Bok Choy', NULL, NULL),
    (N'Brussels Sprouts', NULL, NULL),
    (N'Cauliflower', NULL, NULL),
    (N'Celery', NULL, NULL),
    (N'Cucumber', NULL, NULL),
    (N'Eggplant', NULL, NULL),
    (N'Fennel', NULL, NULL),
    (N'Kale', NULL, NULL),
    (N'Mushrooms', NULL, NULL),
    (N'Parsnip', NULL, NULL),
    (N'Pumpkin', NULL, NULL),
    (N'Radish', NULL, NULL),
    (N'Red Cabbage', NULL, NULL),
    (N'Silverbeet', NULL, NULL),
    (N'Spinach', NULL, NULL),
    (N'Sprouts', NULL, NULL),
    (N'Watercress', NULL, NULL),
    (N'Bean Sprouts', NULL, NULL),
    (N'Artichoke Hearts', NULL, NULL),
    (N'Olives', NULL, NULL),
    (N'Kalamata Olives', NULL, NULL),
    (N'Sun Dried Tomatoes', NULL, NULL),
    (N'Roasted Red Peppers', NULL, NULL),
    (N'Pickles', NULL, NULL),
    (N'Gherkins', NULL, NULL),
    (N'Capers', NULL, NULL),
    (N'Water Chestnuts', NULL, NULL),
    (N'Bamboo Shoots', NULL, NULL),
    (N'Frozen Chips', NULL, NULL),
    (N'Hash Browns', NULL, NULL),
    (N'Edamame', NULL, NULL),
    (N'Bananas', NULL, NULL),
    (N'Lemons', NULL, NULL),
    (N'Limes', NULL, NULL),
    (N'Raisins', NULL, NULL),
    (N'Pears', NULL, NULL),
    (N'Grapes', NULL, NULL),
    (N'Kiwifruit', NULL, NULL),
    (N'Mandarins', NULL, NULL),
    (N'Peaches', NULL, NULL),
    (N'Plums', NULL, NULL),
    (N'Nectarines', NULL, NULL),
    (N'Apricots', NULL, NULL),
    (N'Cherries', NULL, NULL),
    (N'Mango', NULL, NULL),
    (N'Watermelon', NULL, NULL),
    (N'Rockmelon', NULL, NULL),
    (N'Raspberries', NULL, NULL),
    (N'Feijoas', NULL, NULL),
    (N'Passionfruit', NULL, NULL),
    (N'Dates', NULL, NULL),
    (N'Dried Apricots', NULL, NULL),
    (N'Dried Cranberries', NULL, NULL),
    (N'Lemon Juice', NULL, NULL),
    (N'Lime Juice', NULL, NULL),
    (N'Orange Juice', NULL, NULL),
    (N'Lemon Zest', NULL, NULL),
    (N'Lime Zest', NULL, NULL),
    (N'Sour Cream', NULL, NULL),
    (N'Cream Cheese', NULL, NULL),
    (N'Cottage Cheese', NULL, NULL),
    (N'Mascarpone', NULL, NULL),
    (N'Halloumi', NULL, NULL),
    (N'Blue Cheese', NULL, NULL),
    (N'Brie', NULL, NULL),
    (N'Camembert', NULL, NULL),
    (N'Swiss Cheese', NULL, NULL),
    (N'Buttermilk', NULL, NULL),
    (N'Almond Milk', NULL, NULL),
    (N'Oat Milk', NULL, NULL),
    (N'Soy Milk', NULL, NULL),
    (N'Lactose Free Milk', NULL, NULL),
    (N'Margarine', NULL, NULL),
    (N'Custard', NULL, NULL),
    (N'Tofu', NULL, NULL),
    (N'Firm Tofu', NULL, NULL),
    (N'Silken Tofu', NULL, NULL),
    (N'Fresh Pasta', NULL, NULL),
    (N'Hummus', NULL, NULL),
    (N'Baking Powder', NULL, NULL),
    (N'Cream Of Tartar', NULL, NULL),
    (N'Gelatine', NULL, NULL),
    (N'Golden Syrup', NULL, NULL),
    (N'Maple Syrup', NULL, NULL),
    (N'Honey', NULL, NULL),
    (N'Corn Syrup', NULL, NULL),
    (N'Raw Sugar', NULL, NULL),
    (N'Food Colouring', NULL, NULL),
    (N'Dark Chocolate', NULL, NULL),
    (N'Milk Chocolate', NULL, NULL),
    (N'White Chocolate', NULL, NULL),
    (N'Cooking Chocolate', NULL, NULL),
    (N'Sprinkles', NULL, NULL),
    (N'Marshmallows', NULL, NULL),
    (N'Gluten Free Flour', NULL, NULL),
    (N'Rice Flour', NULL, NULL),
    (N'Wholemeal Flour', NULL, NULL),
    (N'Semolina', NULL, NULL),
    (N'Polenta', NULL, NULL),
    (N'Cornmeal', NULL, NULL),
    (N'Chia Seeds', NULL, NULL),
    (N'Flaxseed', NULL, NULL),
    (N'LSA', NULL, NULL),
    (N'Muesli', NULL, NULL),
    (N'Weet-Bix', NULL, NULL),
    (N'Cornflakes', NULL, NULL),
    (N'Jelly Crystals', NULL, NULL),
    (N'Instant Pudding', NULL, NULL),
    (N'Biscuits', NULL, NULL),
    (N'Digestive Biscuits', NULL, NULL),
    (N'Graham Crackers', NULL, NULL),
    (N'Fish Sauce', NULL, NULL),
    (N'Oyster Sauce', NULL, NULL),
    (N'Hoisin Sauce', NULL, NULL),
    (N'Teriyaki Sauce', NULL, NULL),
    (N'Dark Soy Sauce', NULL, NULL),
    (N'Kecap Manis', NULL, NULL),
    (N'Sriracha', NULL, NULL),
    (N'Tabasco', NULL, NULL),
    (N'Sambal Oelek', NULL, NULL),
    (N'Curry Paste', NULL, NULL),
    (N'Red Curry Paste', NULL, NULL),
    (N'Green Curry Paste', NULL, NULL),
    (N'Massaman Curry Paste', NULL, NULL),
    (N'Tikka Masala Paste', NULL, NULL),
    (N'Butter Chicken Sauce', NULL, NULL),
    (N'Pesto', NULL, NULL),
    (N'Basil Pesto', NULL, NULL),
    (N'Tahini', NULL, NULL),
    (N'Miso Paste', NULL, NULL),
    (N'Gochujang', NULL, NULL),
    (N'Dijon Mustard', NULL, NULL),
    (N'Wholegrain Mustard', NULL, NULL),
    (N'Horseradish', NULL, NULL),
    (N'Mint Sauce', NULL, NULL),
    (N'Relish', NULL, NULL),
    (N'Chutney', NULL, NULL),
    (N'Salsa', NULL, NULL),
    (N'Aioli', NULL, NULL),
    (N'Ranch Dressing', NULL, NULL),
    (N'Caesar Dressing', NULL, NULL),
    (N'Gravy Granules', NULL, NULL),
    (N'Gravy Mix', NULL, NULL),
    (N'Balsamic Vinegar', NULL, NULL),
    (N'Red Wine Vinegar', NULL, NULL),
    (N'White Wine Vinegar', NULL, NULL),
    (N'Rice Vinegar', NULL, NULL),
    (N'Malt Vinegar', NULL, NULL),
    (N'Peanut Oil', NULL, NULL),
    (N'Cooking Spray', NULL, NULL),
    (N'Jam', NULL, NULL),
    (N'Strawberry Jam', NULL, NULL),
    (N'Marmite', NULL, NULL),
    (N'Vegemite', NULL, NULL),
    (N'Nutella', NULL, NULL),
    (N'Tomato Soup', NULL, NULL),
    (N'Cream Of Mushroom Soup', NULL, NULL),
    (N'Cream Of Chicken Soup', NULL, NULL),
    (N'Beer', NULL, NULL),
    (N'Cooking Wine', NULL, NULL),
    (N'Mirin', NULL, NULL),
    (N'Sake', NULL, NULL),
    (N'Brandy', NULL, NULL),
    (N'Rum', NULL, NULL),
    (N'Gluten Free Pasta', NULL, NULL),
    (N'Gluten Free Bread', NULL, NULL),
    (N'Gluten Free Wraps', NULL, NULL),
    (N'Orzo', NULL, NULL),
    (N'Tortellini', NULL, NULL),
    (N'Ravioli', NULL, NULL),
    (N'Gnocchi', NULL, NULL),
    (N'Udon Noodles', NULL, NULL),
    (N'Soba Noodles', NULL, NULL),
    (N'Hokkien Noodles', NULL, NULL),
    (N'Couscous', NULL, NULL),
    (N'Quinoa', NULL, NULL),
    (N'Pearl Barley', NULL, NULL),
    (N'Sushi Rice', NULL, NULL),
    (N'Wild Rice', NULL, NULL),
    (N'Microwave Rice', NULL, NULL),
    (N'Crackers', NULL, NULL),
    (N'Rice Crackers', NULL, NULL),
    (N'Bread Rolls', NULL, NULL),
    (N'Naan', NULL, NULL),
    (N'Garlic Bread', NULL, NULL),
    (N'English Muffins', NULL, NULL),
    (N'Crumpets', NULL, NULL),
    (N'Bagels', NULL, NULL),
    (N'Corn Tortillas', NULL, NULL),
    (N'Taco Shells', NULL, NULL),
    (N'Corn Chips', NULL, NULL),
    (N'Potato Chips', NULL, NULL),
    (N'Pizza Bases', NULL, NULL),
    (N'Allspice', NULL, NULL),
    (N'Ground Ginger', NULL, NULL),
    (N'Cardamom', NULL, NULL),
    (N'Cloves', NULL, NULL),
    (N'Coriander Seeds', NULL, NULL),
    (N'Ground Coriander', NULL, NULL),
    (N'Curry Powder', NULL, NULL),
    (N'Fennel Seeds', NULL, NULL),
    (N'Five Spice', NULL, NULL),
    (N'Garam Masala', NULL, NULL),
    (N'Mustard Seeds', NULL, NULL),
    (N'Smoked Paprika', NULL, NULL),
    (N'Star Anise', NULL, NULL),
    (N'Sumac', NULL, NULL),
    (N'Za''atar', NULL, NULL),
    (N'Saffron', NULL, NULL),
    (N'Mixed Spice', NULL, NULL),
    (N'Celery Salt', NULL, NULL),
    (N'Garlic Salt', NULL, NULL),
    (N'Onion Salt', NULL, NULL),
    (N'Chicken Salt', NULL, NULL),
    (N'Lemon Pepper', NULL, NULL),
    (N'Steak Seasoning', NULL, NULL),
    (N'Chinese Five Spice', NULL, NULL),
    (N'Vanilla Pod', NULL, NULL),
    (N'Tarragon', NULL, NULL),
    (N'Marjoram', NULL, NULL),
    (N'Lemongrass', NULL, NULL),
    (N'Kaffir Lime Leaves', NULL, NULL),
    (N'Curry Leaves', NULL, NULL),
    (N'Cashews', NULL, NULL),
    (N'Peanuts', NULL, NULL),
    (N'Pine Nuts', NULL, NULL),
    (N'Pistachios', NULL, NULL),
    (N'Hazelnuts', NULL, NULL),
    (N'Macadamias', NULL, NULL),
    (N'Brazil Nuts', NULL, NULL),
    (N'Mixed Nuts', NULL, NULL),
    (N'Pumpkin Seeds', NULL, NULL),
    (N'Sunflower Seeds', NULL, NULL),
    (N'Almond Butter', NULL, NULL),
    (N'Coconut Flakes', NULL, NULL),
    (N'Frozen Berries', NULL, NULL),
    (N'Ice Cream', NULL, NULL),
    (N'Frozen Pizza', NULL, NULL),
    (N'Frozen Prawns', NULL, NULL),
    (N'Frozen Fish Fillets', NULL, NULL),
    (N'Frozen Dumplings', NULL, NULL),
    (N'Spring Rolls', NULL, NULL),
    (N'Mince', NULL, NULL),
    (N'Stewing Beef', NULL, NULL),
    (N'Scotch Fillet', NULL, NULL),
    (N'Eye Fillet', NULL, NULL),
    (N'Sirloin Steak', NULL, NULL),
    (N'Beef Stir Fry Strips', NULL, NULL),
    (N'Leg of Lamb', NULL, NULL),
    (N'Pork Fillet', NULL, NULL),
    (N'Pork Shoulder', NULL, NULL),
    (N'Chicken Breast', NULL, NULL),
    (N'Chicken Thigh', NULL, NULL),
    (N'Chicken Drumsticks', NULL, NULL),
    (N'Roast Chicken', NULL, NULL),
    (N'Bacon', NULL, NULL),
    (N'Ham', NULL, NULL),
    (N'Sausages', NULL, NULL),
    (N'Smoked Sausage', NULL, NULL),
    (N'Chorizo', NULL, NULL),
    (N'Pepperoni', NULL, NULL),
    (N'Prawns', NULL, NULL),
    (N'White Fish', NULL, NULL),
    (N'Salmon', NULL, NULL),
    (N'Onion', NULL, NULL),
    (N'Spring Onions', NULL, NULL),
    (N'Garlic', NULL, NULL),
    (N'Ginger', NULL, NULL),
    (N'Courgette', NULL, NULL),
    (N'Rocket', NULL, NULL),
    (N'Swede', NULL, NULL),
    (N'Kumara', NULL, NULL),
    (N'Potato', NULL, NULL),
    (N'Carrot', NULL, NULL),
    (N'Capsicum', NULL, NULL),
    (N'Broccoli', NULL, NULL),
    (N'Lettuce', NULL, NULL),
    (N'Salad Leaves', NULL, NULL),
    (N'Cabbage', NULL, NULL),
    (N'Tomatoes', NULL, NULL),
    (N'Cherry Tomatoes', NULL, NULL),
    (N'Butternut Pumpkin', NULL, NULL),
    (N'Snow Peas', NULL, NULL),
    (N'Green Beans', NULL, NULL),
    (N'Peas', NULL, NULL),
    (N'Corn Cobs', NULL, NULL),
    (N'Mixed Vege', NULL, NULL),
    (N'Stir Fry Vege', NULL, NULL),
    (N'Jalapenos', NULL, NULL),
    (N'Chilli', NULL, NULL),
    (N'Coriander', NULL, NULL),
    (N'Parsley', NULL, NULL),
    (N'Basil', NULL, NULL),
    (N'Thyme', NULL, NULL),
    (N'Rosemary', NULL, NULL),
    (N'Sage', NULL, NULL),
    (N'Mint', NULL, NULL),
    (N'Dill', NULL, NULL),
    (N'Chives', NULL, NULL),
    (N'Apples', NULL, NULL),
    (N'Oranges', NULL, NULL),
    (N'Avocados', NULL, NULL),
    (N'Blueberries', NULL, NULL),
    (N'Strawberries', NULL, NULL),
    (N'Mixed Berries', NULL, NULL),
    (N'Pineapple', NULL, NULL),
    (N'Sultanas', NULL, NULL),
    (N'Cream', NULL, NULL),
    (N'Milk', NULL, NULL),
    (N'Butter', NULL, NULL),
    (N'Cheese', NULL, NULL),
    (N'Cheese Slices', NULL, NULL),
    (N'Mozzarella', NULL, NULL),
    (N'Parmesan', NULL, NULL),
    (N'Feta', NULL, NULL),
    (N'Ricotta', NULL, NULL),
    (N'Yoghurt', NULL, NULL),
    (N'Eggs', NULL, NULL),
    (N'Flour', NULL, NULL),
    (N'Self Raising Flour', NULL, NULL),
    (N'High Grade Flour', NULL, NULL),
    (N'Cornflour', NULL, NULL),
    (N'Baking Soda', NULL, NULL),
    (N'Sugar', NULL, NULL),
    (N'Icing Sugar', NULL, NULL),
    (N'Brown Sugar', NULL, NULL),
    (N'Vanilla Essence', NULL, NULL),
    (N'Cocoa', NULL, NULL),
    (N'Chocolate Chips', NULL, NULL),
    (N'Treacle', NULL, NULL),
    (N'Yeast', NULL, NULL),
    (N'Rolled Oats', NULL, NULL),
    (N'Breadcrumbs', NULL, NULL),
    (N'Desiccated Coconut', NULL, NULL),
    (N'Short Pastry', NULL, NULL),
    (N'Puff Pastry', NULL, NULL),
    (N'Filo Pastry', NULL, NULL),
    (N'Olive Oil', NULL, NULL),
    (N'Vegetable Oil', NULL, NULL),
    (N'Sesame Oil', NULL, NULL),
    (N'White Vinegar', NULL, NULL),
    (N'Apple Cider Vinegar', NULL, NULL),
    (N'Pasta Sauce', NULL, NULL),
    (N'Tomato Paste', NULL, NULL),
    (N'Tomato Sauce', NULL, NULL),
    (N'Mayonnaise', NULL, NULL),
    (N'Mustard', NULL, NULL),
    (N'Soy Sauce', NULL, NULL),
    (N'BBQ Sauce', NULL, NULL),
    (N'Worcestershire Sauce', NULL, NULL),
    (N'Chilli Sauce', NULL, NULL),
    (N'Sweet Chilli Sauce', NULL, NULL),
    (N'Chicken Stock', NULL, NULL),
    (N'Beef Stock', NULL, NULL),
    (N'Vegetable Stock', NULL, NULL),
    (N'Stock Cubes', NULL, NULL),
    (N'Apple Juice', NULL, NULL),
    (N'White Wine', NULL, NULL),
    (N'Red Wine', NULL, NULL),
    (N'Shaoxing Wine', NULL, NULL),
    (N'Pasta', NULL, NULL),
    (N'Instant Noodles', NULL, NULL),
    (N'Rice Noodles', NULL, NULL),
    (N'Rice', NULL, NULL),
    (N'Arborio Rice', NULL, NULL),
    (N'Bread', NULL, NULL),
    (N'Burger Buns', NULL, NULL),
    (N'Hot Dog Rolls', NULL, NULL),
    (N'Wraps', NULL, NULL),
    (N'French Stick', NULL, NULL),
    (N'Pita Bread', NULL, NULL),
    (N'Salt', NULL, NULL),
    (N'Pepper', NULL, NULL),
    (N'Chilli Flakes', NULL, NULL),
    (N'Chilli Powder', NULL, NULL),
    (N'Cayenne Pepper', NULL, NULL),
    (N'Cumin', NULL, NULL),
    (N'Cinnamon', NULL, NULL),
    (N'Nutmeg', NULL, NULL),
    (N'Turmeric', NULL, NULL),
    (N'Paprika', NULL, NULL),
    (N'Oregano', NULL, NULL),
    (N'Mixed Herbs', NULL, NULL),
    (N'Bay Leaves', NULL, NULL),
    (N'Garlic Powder', NULL, NULL),
    (N'Onion Powder', NULL, NULL),
    (N'Taco Seasoning', NULL, NULL),
    (N'Cajun Seasoning', NULL, NULL),
    (N'Peanut Butter', NULL, NULL),
    (N'Almonds', NULL, NULL),
    (N'Almond Meal', NULL, NULL),
    (N'Walnuts', NULL, NULL),
    (N'Pecans', NULL, NULL),
    (N'Sesame Seeds', NULL, NULL);

-- -------------------------------------------------------------
-- 2. INGREDIENTS - built-in ones first, then your aliases' names
-- -------------------------------------------------------------
CREATE TABLE dbo.ingredients (
    ingredient_name NVARCHAR(200) CONSTRAINT PK_ingredients PRIMARY KEY,
    tin_quantity    DECIMAL(12,3) NULL,   -- size of one tin, if it comes in tins
    tin_unit        NVARCHAR(20)  NULL,
    source          NVARCHAR(10)  NOT NULL CONSTRAINT DF_ingredients_source DEFAULT 'yours'
                    CONSTRAINT CK_ingredients_source CHECK (source IN ('built_in', 'yours'))
);

INSERT INTO dbo.ingredients (ingredient_name, tin_quantity, tin_unit, source)
SELECT MIN(ingredient_name), MAX(tin_quantity), MAX(tin_unit), 'built_in'
FROM (
    SELECT ingredient_name, tin_quantity, tin_unit FROM #builtin_ingredient
    UNION ALL SELECT ingredient_name, NULL, NULL FROM #builtin_alias
) AS b
GROUP BY ingredient_name;

INSERT INTO dbo.ingredients (ingredient_name, source)
SELECT MIN(a.canonical_name), 'yours'
FROM dbo.ingredient_aliases a
WHERE NOT EXISTS (SELECT 1 FROM dbo.ingredients i WHERE i.ingredient_name = a.canonical_name)
GROUP BY a.canonical_name;

-- -------------------------------------------------------------
-- 3. ALL ALIASES - yours, plus every built-in one you don't have
-- -------------------------------------------------------------
CREATE TABLE #alias (
    alias           NVARCHAR(200) COLLATE DATABASE_DEFAULT PRIMARY KEY,
    ingredient_name NVARCHAR(200) COLLATE DATABASE_DEFAULT,
    source          NVARCHAR(10)  COLLATE DATABASE_DEFAULT
);
INSERT INTO #alias (alias, ingredient_name, source)
SELECT alias, canonical_name, 'yours' FROM dbo.ingredient_aliases;

INSERT INTO #alias (alias, ingredient_name, source)
SELECT b.alias, MIN(b.ingredient_name), 'built_in'
FROM #builtin_alias b
WHERE NOT EXISTS (SELECT 1 FROM #alias a WHERE a.alias = b.alias)
GROUP BY b.alias;

-- -------------------------------------------------------------
-- 4. MATCHING KEYS - every name tidied the same way the website's
-- normalizeIngredientName() does: lower case, apostrophes removed,
-- hyphens/underscores as spaces, single spaces, and a plural LAST
-- word made singular (tomatoes -> tomato, berries -> berry,
-- onions -> onion, but not "swiss").
-- -------------------------------------------------------------
CREATE TABLE #raw (name NVARCHAR(300) COLLATE DATABASE_DEFAULT PRIMARY KEY);

INSERT INTO #raw (name)
SELECT DISTINCT n FROM (
    SELECT ingredient_name AS n FROM dbo.ingredients
    UNION SELECT alias FROM #alias
    UNION SELECT ingredient_name FROM #alias
    UNION SELECT name FROM dbo.inventory
    UNION SELECT ingredient_name FROM dbo.recipe_ingredients
    UNION SELECT name FROM dbo.stock_minimums
    UNION SELECT item_name FROM dbo.barcodes
) AS all_names
WHERE n IS NOT NULL AND LTRIM(RTRIM(n)) <> '';

CREATE TABLE #keyed (
    name NVARCHAR(300) COLLATE DATABASE_DEFAULT PRIMARY KEY,
    k    NVARCHAR(300) COLLATE DATABASE_DEFAULT
);

INSERT INTO #keyed (name, k)
SELECT r.name,
       d.head + CASE
           WHEN LEN(d.lastw) > 3 AND d.lastw LIKE '%oes' THEN LEFT(d.lastw, LEN(d.lastw) - 2)
           WHEN LEN(d.lastw) > 3 AND d.lastw LIKE '%ies' THEN LEFT(d.lastw, LEN(d.lastw) - 3) + 'y'
           WHEN LEN(d.lastw) > 3 AND d.lastw LIKE '%s' AND d.lastw NOT LIKE '%ss' THEN LEFT(d.lastw, LEN(d.lastw) - 1)
           ELSE d.lastw END
FROM #raw r
CROSS APPLY (SELECT s1 = LOWER(LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(REPLACE(r.name, '''', ''), NCHAR(8217), ''), '-', ' '), '_', ' '))))) a
CROSS APPLY (SELECT s2 = REPLACE(REPLACE(REPLACE(REPLACE(a.s1, '    ', ' '), '   ', ' '), '  ', ' '), '  ', ' ')) b
CROSS APPLY (SELECT sp = CHARINDEX(' ', REVERSE(b.s2))) c
CROSS APPLY (SELECT head  = CASE WHEN c.sp = 0 THEN '' ELSE LEFT(b.s2, LEN(b.s2) - c.sp + 1) END,
                    lastw = CASE WHEN c.sp = 0 THEN b.s2 ELSE RIGHT(b.s2, c.sp - 1) END) d;

-- alias key -> the key of the name it points at (first one wins,
-- yours before built-in, same as the website)
CREATE TABLE #alias_key (
    k          NVARCHAR(300) COLLATE DATABASE_DEFAULT PRIMARY KEY,
    target_key NVARCHAR(300) COLLATE DATABASE_DEFAULT
);
INSERT INTO #alias_key (k, target_key)
SELECT k, target_key FROM (
    SELECT ka.k, kt.k AS target_key,
           ROW_NUMBER() OVER (PARTITION BY ka.k ORDER BY CASE a.source WHEN 'yours' THEN 0 ELSE 1 END, a.alias) AS pick
    FROM #alias a
    JOIN #keyed ka ON ka.name = a.alias
    JOIN #keyed kt ON kt.name = a.ingredient_name
) AS x
WHERE pick = 1;

-- ingredient key -> ingredient name
CREATE TABLE #ingredient_key (
    k               NVARCHAR(300) COLLATE DATABASE_DEFAULT PRIMARY KEY,
    ingredient_name NVARCHAR(200) COLLATE DATABASE_DEFAULT
);
INSERT INTO #ingredient_key (k, ingredient_name)
SELECT kk.k, MIN(i.ingredient_name)
FROM dbo.ingredients i
JOIN #keyed kk ON kk.name = i.ingredient_name
GROUP BY kk.k;

-- -------------------------------------------------------------
-- 5. LINK every name in use to an ingredient: follow the aliases
-- (up to 10 steps, like the website), then find the ingredient with
-- that key - or add a new ingredient named as typed.
-- -------------------------------------------------------------
CREATE TABLE #typed (
    name            NVARCHAR(300) COLLATE DATABASE_DEFAULT PRIMARY KEY,
    final_k         NVARCHAR(300) COLLATE DATABASE_DEFAULT,
    ingredient_name NVARCHAR(200) COLLATE DATABASE_DEFAULT NULL
);
INSERT INTO #typed (name, final_k)
SELECT kk.name, kk.k
FROM #keyed kk
WHERE kk.name IN (SELECT name FROM dbo.inventory
                  UNION SELECT ingredient_name FROM dbo.recipe_ingredients
                  UNION SELECT name FROM dbo.stock_minimums
                  UNION SELECT item_name FROM dbo.barcodes);

DECLARE @step INT = 0;
WHILE @step < 10
BEGIN
    UPDATE t SET final_k = ak.target_key
    FROM #typed t
    JOIN #alias_key ak ON ak.k = t.final_k
    WHERE ak.target_key <> t.final_k;
    IF @@ROWCOUNT = 0 BREAK;
    SET @step = @step + 1;
END;

UPDATE t SET ingredient_name = ik.ingredient_name
FROM #typed t
JOIN #ingredient_key ik ON ik.k = t.final_k;

-- No match anywhere: a new ingredient, named as typed (one per key).
INSERT INTO dbo.ingredients (ingredient_name, source)
SELECT MIN(name), 'yours'
FROM #typed
WHERE ingredient_name IS NULL
GROUP BY final_k;

UPDATE t SET ingredient_name = nw.ingredient_name
FROM #typed t
JOIN (SELECT final_k, MIN(name) AS ingredient_name FROM #typed WHERE ingredient_name IS NULL GROUP BY final_k) AS nw
  ON nw.final_k = t.final_k
WHERE t.ingredient_name IS NULL;

-- -------------------------------------------------------------
-- 6. Keep copies of the tables being rebuilt, then rebuild them
-- -------------------------------------------------------------
SELECT * INTO #old_inventory FROM dbo.inventory;
SELECT * INTO #old_recipe_ingredients FROM dbo.recipe_ingredients;
SELECT * INTO #old_stock_minimums FROM dbo.stock_minimums;
SELECT * INTO #old_barcodes FROM dbo.barcodes;

DROP TABLE dbo.recipe_ingredients;
DROP TABLE dbo.inventory;
DROP TABLE dbo.stock_minimums;
DROP TABLE dbo.barcodes;
DROP TABLE dbo.ingredient_aliases;

-- INGREDIENT ALIASES - each alternative name points at one ingredient.
CREATE TABLE dbo.ingredient_aliases (
    alias           NVARCHAR(200) CONSTRAINT PK_ingredient_aliases PRIMARY KEY,
    ingredient_name NVARCHAR(200) NOT NULL
                    CONSTRAINT FK_ingredient_aliases_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    source          NVARCHAR(10)  NOT NULL CONSTRAINT DF_ingredient_aliases_source DEFAULT 'yours'
                    CONSTRAINT CK_ingredient_aliases_source CHECK (source IN ('built_in', 'yours'))
);

-- INVENTORY - name as typed, linked to its ingredient.
CREATE TABLE dbo.inventory (
    location_code   NVARCHAR(10)  NOT NULL
                    CONSTRAINT FK_inventory_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    name            NVARCHAR(200) NOT NULL,
    unit            NVARCHAR(20)  NOT NULL,
    ingredient_name NVARCHAR(200) NOT NULL
                    CONSTRAINT FK_inventory_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    quantity        DECIMAL(12,3) NOT NULL,
    track           NVARCHAR(10)  NULL CONSTRAINT CK_inventory_track CHECK (track IN ('have', 'amount')),
    low             BIT NOT NULL CONSTRAINT DF_inventory_low DEFAULT 0,
    CONSTRAINT PK_inventory PRIMARY KEY (location_code, name, unit)
);

-- RECIPE INGREDIENTS - name as the recipe words it, linked to its ingredient.
CREATE TABLE dbo.recipe_ingredients (
    recipe_id       NVARCHAR(20)  NOT NULL
                    CONSTRAINT FK_recipe_ingredients_recipe REFERENCES dbo.recipes(recipe_id) ON DELETE CASCADE,
    name            NVARCHAR(200) NOT NULL,
    unit            NVARCHAR(20)  NOT NULL CONSTRAINT DF_recipe_ingredients_unit DEFAULT '',
    ingredient_name NVARCHAR(200) NOT NULL
                    CONSTRAINT FK_recipe_ingredients_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    quantity        DECIMAL(12,3) NULL,
    sort_order      INT NOT NULL,
    CONSTRAINT PK_recipe_ingredients PRIMARY KEY (recipe_id, name, unit)
);

-- STOCK MINIMUMS - name as typed, linked to its ingredient.
CREATE TABLE dbo.stock_minimums (
    name            NVARCHAR(200) NOT NULL,
    unit            NVARCHAR(20)  NOT NULL,
    ingredient_name NVARCHAR(200) NOT NULL
                    CONSTRAINT FK_stock_minimums_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    minimum         DECIMAL(12,3) NOT NULL,
    CONSTRAINT PK_stock_minimums PRIMARY KEY (name, unit)
);

-- BARCODES - your name for the product, linked to its ingredient.
CREATE TABLE dbo.barcodes (
    barcode            NVARCHAR(50)  CONSTRAINT PK_barcodes PRIMARY KEY,
    item_name          NVARCHAR(200) NOT NULL,
    ingredient_name    NVARCHAR(200) NOT NULL
                       CONSTRAINT FK_barcodes_ingredient REFERENCES dbo.ingredients(ingredient_name) ON UPDATE CASCADE,
    brand              NVARCHAR(100) NULL,
    product_name       NVARCHAR(300) NULL,
    quantity           DECIMAL(12,3) NULL,
    unit               NVARCHAR(20)  NULL,
    location_code      NVARCHAR(10)  NULL
                       CONSTRAINT FK_barcodes_location REFERENCES dbo.locations(location_code) ON UPDATE CASCADE,
    source             NVARCHAR(20)  NULL,
    added_by_person_id INT NULL
                       CONSTRAINT FK_barcodes_person REFERENCES dbo.people(person_id),
    date_added         DATE NULL
);

EXEC (N'
INSERT INTO dbo.ingredient_aliases (alias, ingredient_name, source)
SELECT alias, ingredient_name, source FROM #alias;

INSERT INTO dbo.inventory (location_code, name, unit, ingredient_name, quantity, track, low)
SELECT o.location_code, o.name, o.unit, t.ingredient_name, o.quantity, o.track, o.low
FROM #old_inventory o JOIN #typed t ON t.name = o.name;

INSERT INTO dbo.recipe_ingredients (recipe_id, name, unit, ingredient_name, quantity, sort_order)
SELECT o.recipe_id, o.ingredient_name, o.unit, t.ingredient_name, o.quantity, o.sort_order
FROM #old_recipe_ingredients o JOIN #typed t ON t.name = o.ingredient_name;

INSERT INTO dbo.stock_minimums (name, unit, ingredient_name, minimum)
SELECT o.name, o.unit, t.ingredient_name, o.minimum
FROM #old_stock_minimums o JOIN #typed t ON t.name = o.name;

INSERT INTO dbo.barcodes (barcode, item_name, ingredient_name, brand, product_name, quantity, unit, location_code, source, added_by_person_id, date_added)
SELECT o.barcode, o.item_name, t.ingredient_name, o.brand, o.product_name, o.quantity, o.unit, o.location_code, o.source, o.added_by_person_id, o.date_added
FROM #old_barcodes o JOIN #typed t ON t.name = o.item_name;

-- Every row must have come across - if any did not find its link,
-- stop and roll everything back.
IF (SELECT COUNT(*) FROM dbo.inventory) <> (SELECT COUNT(*) FROM #old_inventory)
   OR (SELECT COUNT(*) FROM dbo.recipe_ingredients) <> (SELECT COUNT(*) FROM #old_recipe_ingredients)
   OR (SELECT COUNT(*) FROM dbo.stock_minimums) <> (SELECT COUNT(*) FROM #old_stock_minimums)
   OR (SELECT COUNT(*) FROM dbo.barcodes) <> (SELECT COUNT(*) FROM #old_barcodes)
    THROW 50001, ''Some rows did not come across - nothing was changed.'', 1;
');

COMMIT TRANSACTION;

-- Row counts after the upgrade, and how each name you use was linked.
-- (Check the second list: each name on the left should point at the
-- ingredient you'd expect on the right.)
SELECT 'ingredients' AS table_name, COUNT(*) AS row_count FROM dbo.ingredients
UNION ALL SELECT 'ingredient_aliases', COUNT(*) FROM dbo.ingredient_aliases
UNION ALL SELECT 'inventory', COUNT(*) FROM dbo.inventory
UNION ALL SELECT 'recipe_ingredients', COUNT(*) FROM dbo.recipe_ingredients
UNION ALL SELECT 'stock_minimums', COUNT(*) FROM dbo.stock_minimums
UNION ALL SELECT 'barcodes', COUNT(*) FROM dbo.barcodes;

SELECT name AS name_as_typed, ingredient_name AS linked_to_ingredient
FROM #typed
ORDER BY ingredient_name, name;
