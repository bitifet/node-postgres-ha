import deadPool_tests from "./pool_dead_connection.test.mjs";

import node_postgres_ha from "../node_postgres_ha.js";

deadPool_tests("node_postgres_ha", node_postgres_ha);

