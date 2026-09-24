-- First load of KICD learning areas (rationalised CBE curriculum, 2024
-- rationalisation onward), one row per learning area per band.
--
-- EVERY ROW IS UNVERIFIED (verified_at null). Public summaries of the
-- rationalised designs disagree with each other -- e.g. on whether Senior
-- School's compulsory core is four areas or seven, and on Upper Primary's
-- exact list -- and none of them is KICD's own design document. Figbloom
-- staff check each band against the official designs (kicd.ac.ke) on
-- Platform > Curriculum and mark rows verified there; corrections are edits
-- on that page, not new migrations. No strands are seeded: those come from the
-- curriculum designs themselves, via the CSV import on the same page.

insert into learning_areas (code, name, level, min_grade, max_grade, is_core, pathway, track, sort_order, source) values
  -- Pre-primary, PP1-PP2
  ('PP-LANG',  'Language Activities',                 'pre_primary', 1, 2, true, null, null, 10, 'KICD rationalised CBE (public summaries); unverified'),
  ('PP-MATH',  'Mathematical Activities',             'pre_primary', 1, 2, true, null, null, 20, 'KICD rationalised CBE (public summaries); unverified'),
  ('PP-ENV',   'Environmental Activities',            'pre_primary', 1, 2, true, null, null, 30, 'KICD rationalised CBE (public summaries); unverified'),
  ('PP-PCA',   'Psychomotor and Creative Activities', 'pre_primary', 1, 2, true, null, null, 40, 'KICD rationalised CBE (public summaries); unverified'),
  ('PP-RE',    'Religious Education Activities',      'pre_primary', 1, 2, true, null, null, 50, 'KICD rationalised CBE (public summaries); unverified'),

  -- Lower primary, Grade 1-3
  ('LP-IND',   'Indigenous Language Activities',      'primary', 1, 3, true, null, null, 110, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-KIS',   'Kiswahili Language Activities',       'primary', 1, 3, true, null, null, 120, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-KSL',   'Kenyan Sign Language',                'primary', 1, 3, false, null, null, 125, 'KICD rationalised CBE (public summaries); alternative to Kiswahili; unverified'),
  ('LP-ENG',   'English Language Activities',         'primary', 1, 3, true, null, null, 130, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-MATH',  'Mathematical Activities',             'primary', 1, 3, true, null, null, 140, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-RE',    'Religious Education Activities',      'primary', 1, 3, true, null, null, 150, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-ENV',   'Environmental Activities',            'primary', 1, 3, true, null, null, 160, 'KICD rationalised CBE (public summaries); unverified'),
  ('LP-CRA',   'Creative Activities',                 'primary', 1, 3, true, null, null, 170, 'KICD rationalised CBE (public summaries); unverified'),

  -- Upper primary, Grade 4-6
  ('UP-ENG',   'English',                             'primary', 4, 6, true, null, null, 210, 'KICD rationalised CBE (public summaries); unverified'),
  ('UP-KIS',   'Kiswahili',                           'primary', 4, 6, true, null, null, 220, 'KICD rationalised CBE (public summaries); unverified'),
  ('UP-KSL',   'Kenyan Sign Language',                'primary', 4, 6, false, null, null, 225, 'KICD rationalised CBE (public summaries); alternative to Kiswahili; unverified'),
  ('UP-MATH',  'Mathematics',                         'primary', 4, 6, true, null, null, 230, 'KICD rationalised CBE (public summaries); unverified'),
  ('UP-RE',    'Religious Education',                 'primary', 4, 6, true, null, null, 240, 'KICD rationalised CBE (public summaries); CRE/IRE/HRE; unverified'),
  ('UP-SCT',   'Science and Technology',              'primary', 4, 6, true, null, null, 250, 'KICD rationalised CBE (public summaries); unverified'),
  ('UP-AGN',   'Agriculture and Nutrition',           'primary', 4, 6, true, null, null, 260, 'KICD rationalised CBE (public summaries); some summaries list Agriculture and Home Science separately; unverified'),
  ('UP-SST',   'Social Studies',                      'primary', 4, 6, true, null, null, 270, 'KICD rationalised CBE (public summaries); unverified'),
  ('UP-CRA',   'Creative Arts',                       'primary', 4, 6, true, null, null, 280, 'KICD rationalised CBE (public summaries); unverified'),

  -- Junior school, Grade 7-9
  ('JS-ENG',   'English',                             'junior_secondary', 7, 9, true, null, null, 310, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-KIS',   'Kiswahili',                           'junior_secondary', 7, 9, true, null, null, 320, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-KSL',   'Kenyan Sign Language',                'junior_secondary', 7, 9, false, null, null, 325, 'KICD rationalised CBE (public summaries); alternative to Kiswahili; unverified'),
  ('JS-MATH',  'Mathematics',                         'junior_secondary', 7, 9, true, null, null, 330, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-RE',    'Religious Education',                 'junior_secondary', 7, 9, true, null, null, 340, 'KICD rationalised CBE (public summaries); CRE/IRE/HRE; unverified'),
  ('JS-SST',   'Social Studies',                      'junior_secondary', 7, 9, true, null, null, 350, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-ISC',   'Integrated Science',                  'junior_secondary', 7, 9, true, null, null, 360, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-PTS',   'Pre-Technical Studies',               'junior_secondary', 7, 9, true, null, null, 370, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-AGN',   'Agriculture and Nutrition',           'junior_secondary', 7, 9, true, null, null, 380, 'KICD rationalised CBE (public summaries); unverified'),
  ('JS-CAS',   'Creative Arts and Sports',            'junior_secondary', 7, 9, true, null, null, 390, 'KICD rationalised CBE (public summaries); unverified'),

  -- Senior school, Grade 10-12: compulsory core
  ('SS-ENG',   'English',                             'senior_school', 10, 12, true, null, null, 410, 'KICD senior school (public summaries); core list differs between sources; unverified'),
  ('SS-KIS',   'Kiswahili',                           'senior_school', 10, 12, true, null, null, 420, 'KICD senior school (public summaries); core list differs between sources; unverified'),
  ('SS-KSL',   'Kenyan Sign Language',                'senior_school', 10, 12, false, null, null, 425, 'KICD senior school (public summaries); alternative to Kiswahili; unverified'),
  ('SS-MATH',  'Mathematics',                         'senior_school', 10, 12, true, null, null, 430, 'KICD senior school (public summaries); core list differs between sources; unverified'),
  ('SS-CSL',   'Community Service Learning',          'senior_school', 10, 12, true, null, null, 440, 'KICD senior school (public summaries); core list differs between sources; unverified'),
  ('SS-PE',    'Physical Education',                  'senior_school', 10, 12, true, null, null, 450, 'KICD senior school (public summaries); core list differs between sources; unverified'),

  -- Senior school electives: STEM
  ('SS-BIO',   'Biology',                             'senior_school', 10, 12, false, 'stem', 'pure_sciences', 510, 'KICD senior school (public summaries); unverified'),
  ('SS-CHEM',  'Chemistry',                           'senior_school', 10, 12, false, 'stem', 'pure_sciences', 520, 'KICD senior school (public summaries); unverified'),
  ('SS-PHY',   'Physics',                             'senior_school', 10, 12, false, 'stem', 'pure_sciences', 530, 'KICD senior school (public summaries); unverified'),
  ('SS-GSC',   'General Science',                     'senior_school', 10, 12, false, 'stem', 'pure_sciences', 540, 'KICD senior school (public summaries); unverified'),
  ('SS-AGR',   'Agriculture',                         'senior_school', 10, 12, false, 'stem', 'applied_sciences', 550, 'KICD senior school (public summaries); unverified'),
  ('SS-COMP',  'Computer Studies',                    'senior_school', 10, 12, false, 'stem', 'applied_sciences', 560, 'KICD senior school (public summaries); unverified'),
  ('SS-HSC',   'Home Science',                        'senior_school', 10, 12, false, 'stem', 'applied_sciences', 570, 'KICD senior school (public summaries); unverified'),
  ('SS-DD',    'Drawing and Design',                  'senior_school', 10, 12, false, 'stem', 'technical_engineering', 580, 'KICD senior school (public summaries); unverified'),
  ('SS-AVT',   'Aviation Technology',                 'senior_school', 10, 12, false, 'stem', 'technical_engineering', 590, 'KICD senior school (public summaries); unverified'),
  ('SS-BCT',   'Building and Construction',           'senior_school', 10, 12, false, 'stem', 'technical_engineering', 600, 'KICD senior school (public summaries); unverified'),
  ('SS-ELT',   'Electrical Technology',               'senior_school', 10, 12, false, 'stem', 'technical_engineering', 610, 'KICD senior school (public summaries); unverified'),
  ('SS-MET',   'Metal Technology',                    'senior_school', 10, 12, false, 'stem', 'technical_engineering', 620, 'KICD senior school (public summaries); unverified'),
  ('SS-PMC',   'Power Mechanics',                     'senior_school', 10, 12, false, 'stem', 'technical_engineering', 630, 'KICD senior school (public summaries); unverified'),
  ('SS-WDT',   'Wood Technology',                     'senior_school', 10, 12, false, 'stem', 'technical_engineering', 640, 'KICD senior school (public summaries); unverified'),
  ('SS-MDT',   'Media Technology',                    'senior_school', 10, 12, false, 'stem', 'technical_engineering', 650, 'KICD senior school (public summaries); unverified'),
  ('SS-MFT',   'Marine and Fisheries Technology',     'senior_school', 10, 12, false, 'stem', 'technical_engineering', 660, 'KICD senior school (public summaries); unverified'),

  -- Senior school electives: Social Sciences
  ('SS-LIT',   'Literature in English',               'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 710, 'KICD senior school (public summaries); unverified'),
  ('SS-FAS',   'Fasihi ya Kiswahili',                 'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 720, 'KICD senior school (public summaries); unverified'),
  ('SS-IND',   'Indigenous Language',                 'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 730, 'KICD senior school (public summaries); unverified'),
  ('SS-ARB',   'Arabic',                              'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 740, 'KICD senior school (public summaries); unverified'),
  ('SS-FRE',   'French',                              'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 750, 'KICD senior school (public summaries); unverified'),
  ('SS-GER',   'German',                              'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 760, 'KICD senior school (public summaries); unverified'),
  ('SS-MAN',   'Mandarin Chinese',                    'senior_school', 10, 12, false, 'social_sciences', 'languages_literature', 770, 'KICD senior school (public summaries); unverified'),
  ('SS-HIS',   'History and Citizenship',             'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 780, 'KICD senior school (public summaries); unverified'),
  ('SS-GEO',   'Geography',                           'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 790, 'KICD senior school (public summaries); unverified'),
  ('SS-CRE',   'Christian Religious Education',       'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 800, 'KICD senior school (public summaries); unverified'),
  ('SS-IRE',   'Islamic Religious Education',         'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 810, 'KICD senior school (public summaries); unverified'),
  ('SS-HRE',   'Hindu Religious Education',           'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 820, 'KICD senior school (public summaries); unverified'),
  ('SS-BST',   'Business Studies',                    'senior_school', 10, 12, false, 'social_sciences', 'humanities_business', 830, 'KICD senior school (public summaries); unverified'),

  -- Senior school electives: Arts & Sports Science
  ('SS-SPR',   'Sports and Recreation',               'senior_school', 10, 12, false, 'arts_sports', 'sports', 910, 'KICD senior school (public summaries); unverified'),
  ('SS-MUS',   'Music and Dance',                     'senior_school', 10, 12, false, 'arts_sports', 'arts', 920, 'KICD senior school (public summaries); unverified'),
  ('SS-THF',   'Theatre and Film',                    'senior_school', 10, 12, false, 'arts_sports', 'arts', 930, 'KICD senior school (public summaries); unverified'),
  ('SS-FIA',   'Fine Arts',                           'senior_school', 10, 12, false, 'arts_sports', 'arts', 940, 'KICD senior school (public summaries); unverified');
