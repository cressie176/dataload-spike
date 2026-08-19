/* @test
params:
  # Same park, same 7-night window — but July (peak) vs November (shoulder).
  # Different selectivity by month is the whole point: spot-check that these
  # produce different plans/costs (proves the seasonal distribution works).
  # July: near-fully-booked, the anti-join finds ~0 available vans.
  - { values: { park_id: 12, from: "2025-07-05", to: "2025-07-12" }, thresholds: { cost: 20000 } }
  # November: the planner estimates ~1-3 available vans but ~536 are free, so the
  # anti-join's row mis-estimate is large. This is an ACKNOWLEDGED override, not a
  # silent pass: an EXISTS anti-join under seasonal skew is inherently hard for the
  # planner to estimate, and the plan (index-driven nested loop) is still healthy.
  # The estimate itself swings build-to-build because ANALYZE samples randomly
  # (planRows seen at both 1 and 3, actualRows stable ~536), so the ratio can reach
  # ~536 — the override is set above that worst case rather than at a tight value
  # that would flake. Exactly the rowCountRatio looseness the README calls for.
  - { values: { park_id: 12, from: "2025-11-05", to: "2025-11-12" }, thresholds: { cost: 20000, rowCountRatio: 1000 } }
*/
SELECT v.id, v.model, v.grade
FROM van v
JOIN pitch p ON p.id = v.pitch_id
WHERE p.park_id = $1
  AND NOT EXISTS (
    SELECT 1
    FROM reservation r
    WHERE r.van_id = v.id
      AND r.start_date < $3
      AND r.end_date > $2
  );
