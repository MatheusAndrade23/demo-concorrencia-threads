# Concorrência e threads: demonstração de bugs

Projeto didático em TypeScript + Node.js + PostgreSQL para uma apresentação sobre
concorrência e threads.

O objetivo deste repositório é **demonstrar problemas de concorrência**, não
resolvê-los. Os bugs são intencionais e estão marcados no código com
`// BUG INTENCIONAL: ...`.

- **Bloco A**: concorrência sem thread nenhuma (event loop, async/await)
- **Bloco B**: paralelismo real com worker_threads

Documentação completa em construção.
