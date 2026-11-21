-- Marketplace M11 — «خريطة المتاجر» and «على طريقك».
--
-- Both questions are «which listed stores have a point inside this box?»: the
-- map asks for the visible box, the route for the box around the line widened
-- by the corridor (the exact distance to the line is then computed on those
-- few rows). A btree on (latitude, longitude) over listed stores with a
-- location answers a box with one range scan on latitude and a filter on
-- longitude — enough for thousands of stores without PostGIS.
CREATE INDEX stores_market_geo_idx ON stores (latitude, longitude)
  WHERE market_status = 'listed' AND latitude IS NOT NULL AND longitude IS NOT NULL;
