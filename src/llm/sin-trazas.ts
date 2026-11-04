/**
 * LangSmith externo está deshabilitado (CLAUDE.md, ADR-004): se fuerza antes de importar LangChain/LangGraph,
 * aunque el entorno del despliegue active el tracing. Importar este módulo primero.
 */
for (const variable of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]) {
  process.env[variable] = "false";
}
export {};
