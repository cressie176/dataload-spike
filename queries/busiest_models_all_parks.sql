/* @test
params:
  # Deliberately expensive: full scan + hash-aggregate of every reservation
  # across all parks joined up to model, no selective predicate. Expected to
  # trip the default cost gate (100) — demonstrates the harness FAILING a query
  # that's fine functionally but would be catastrophic under email-spike load.
  # Left with the default threshold on purpose so it fails.
  - { values: {} }
*/
SELECT v.model,
       count(*) AS bookings,
       avg(r.end_date - r.start_date)::numeric(10, 2) AS avg_nights
FROM reservation r
JOIN van v ON v.id = r.van_id
GROUP BY v.model
ORDER BY bookings DESC;
