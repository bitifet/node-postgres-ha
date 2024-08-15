import pool_resilience_tests from "./pool_resilience.test.mjs";

import node_postgres_ha from "../node_postgres_ha.js";

pool_resilience_tests("node_postgres_ha", node_postgres_ha);

