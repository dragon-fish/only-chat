-- The global image model becomes one slot of the service model set, alongside the text one.
-- Moved rather than read from both places: a settings key with two possible names is a bug waiting
-- for whoever adds the third slot.
UPDATE users
   SET settings = json_remove(
         json_set(
           json_set(settings, '$.service_models', json_object()),
           '$.service_models.image', json_extract(settings, '$.image_model')
         ),
         '$.image_model'
       )
 WHERE json_extract(settings, '$.image_model') IS NOT NULL;--> statement-breakpoint

-- Users who never chose one only need the key gone; there is nothing to carry over.
UPDATE users
   SET settings = json_remove(settings, '$.image_model')
 WHERE json_extract(settings, '$.image_model') IS NULL
   AND json_type(settings, '$.image_model') IS NOT NULL;
