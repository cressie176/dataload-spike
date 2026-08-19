/* @test
skip: "VACUUM cannot run inside a transaction block, so it can't go through the BEGIN..ROLLBACK EXPLAIN wrapper"
*/
VACUUM (ANALYZE) reservation;
