-- This file intentionally has NO `@test` block. It exists to prove the harness's
-- strict coverage path: a query file with no test metadata is not "untested and
-- ignored", it's a FAILURE. Delete this file to make the suite green.
SELECT count(*) FROM park;
