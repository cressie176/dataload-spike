/* @test
params:
  # Full 4-table join (park→pitch→van→reservation) aggregating occupancy per
  # grade for one park over a season. Healthy multi-join queries can mis-estimate
  # by several x up the join tree, so rowCountRatio is loosened here.
  - { values: { park_id: 3, from: "2025-06-01", to: "2025-09-01" }, thresholds: { cost: 40000, rowCountRatio: 25 } }
*/
SELECT v.grade,
       count(DISTINCT v.id) AS vans,
       count(r.id) AS bookings,
       coalesce(sum(r.end_date - r.start_date), 0) AS nights
FROM park pk
JOIN pitch p ON p.park_id = pk.id
JOIN van v ON v.pitch_id = p.id
LEFT JOIN reservation r
  ON r.van_id = v.id
  AND r.start_date >= $2
  AND r.start_date < $3
WHERE pk.id = $1
GROUP BY v.grade
ORDER BY v.grade;
