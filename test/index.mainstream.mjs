import pool_resilience_tests from "./pool_resilience.test.mjs";

import node_postgres from "pg";

pool_resilience_tests("node_postgres", node_postgres);

