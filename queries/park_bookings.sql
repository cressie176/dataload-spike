/* @test
params:
  - { values: { park_id: 7, season_start: "2025-02-01", season_end: "2025-11-30" }, thresholds: { cost: 30000 } }
*/
SELECT count(*) AS bookings, min(r.start_date) AS first, max(r.end_date) AS last
FROM reservation r
JOIN van v ON v.id = r.van_id
JOIN pitch p ON p.id = v.pitch_id
WHERE p.park_id = $1
  AND r.start_date >= $2
  AND r.start_date < $3;
