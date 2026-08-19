/* @test
params:
  # Common grade (saver ~35% of rows) vs rare grade (platinum ~3%). Skew means
  # the planner may pick a seq scan for the common value and an index scan for
  # the rare one — hence separate param sets.
  - { values: { grade: "saver" }, thresholds: { cost: 2000 } }
  - { values: { grade: "platinum" }, thresholds: { cost: 2000 } }
*/
SELECT count(*) AS vans
FROM van
WHERE grade = $1;
