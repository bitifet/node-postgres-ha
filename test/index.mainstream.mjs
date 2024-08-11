import deadPool_tests from "./pool_dead_connection.test.mjs";

import node_postgres from "pg";

deadPool_tests("node_postgres", node_postgres);

