# workflows

Workflows de n8n del sistema agéntico de Leyva Scents, versionados como
código. Aquí viven los JSON exportados desde n8n, los schemas Zod que
definen el contrato del output de cada agente, los system prompts en
Markdown, y los tests unitarios sobre los schemas.

El código TypeScript de este sub-proyecto **NO se ejecuta en producción**.
Los workflows reales corren dentro del container `n8n` en la VM
`leyvascents-n8n` (GCP). Aquí solo se ejecuta en local/CI con `jest` para
validar que los schemas pasan los tests, y con `tsc --noEmit` para
chequeo de tipos.

El propósito de tenerlo como código es que: (a) los workflows quedan en
git con historial y diff revisable, (b) los schemas Zod son la fuente de
verdad del contrato output → Postgres, y (c) los system prompts se
revisan como cualquier otro cambio (PR, blame, rollback).

## Estructura de directorios prevista

Cada agente del pipeline tendrá su propio directorio. Hoy están **vacíos**
hasta sus respectivas fases del rollout:

```
workflows/
├── 01-trend-analyst/             # Fase 5.3.2+
│   ├── prompts/
│   │   └── system-prompt.md
│   ├── schemas/
│   │   └── *.schema.ts
│   ├── __tests__/
│   │   └── *.schema.spec.ts
│   └── trend-analyst.v1.workflow.json
├── 02-sourcing-scout/            # Fase posterior
│   └── (misma estructura)
└── 03-availability-matcher/      # Fase posterior
    └── (misma estructura)
```

## Convenciones de naming

- **Directorios de agente:** `NN-nombre-kebab/` donde `NN` es `01`, `02`,
  `03` — el orden en el pipeline (trend → sourcing → availability).
- **Workflow exportado:** `<nombre>.v<N>.workflow.json`. El versionado
  mayor se incrementa cuando hay un cambio funcional incompatible (cambia
  el schema del output, se renombran nodos críticos, cambia el contrato
  con el webhook). NO se versiona en cada save de n8n.
- **System prompts:** `prompts/system-prompt.md`, un archivo por versión
  mayor. Cambios menores se documentan en un changelog dentro del mismo
  `.md`.
- **Schemas:** `schemas/<entidad>.schema.ts`, con su contraparte de tests
  en `__tests__/<entidad>.schema.spec.ts`.

## Import de un workflow a n8n

1. Abrir la UI de n8n (`https://n8n.leyvascents.mx`).
2. Menú → "Import from File".
3. Seleccionar el archivo `workflows/NN-agente/*.v<N>.workflow.json` de
   este repo.
4. Ajustar credentials post-import. Las IDs de credentials de n8n son
   locales a la instancia y **no se exportan**: hay que re-asociar
   manualmente OpenAI, Postgres, browserless, etc. al workflow importado.

## Export de un workflow desde n8n

1. Abrir el workflow en n8n.
2. Menú "⋯" (top-right del editor) → "Download".
3. Reemplazar el archivo correspondiente en este repo, **manteniendo el
   nombre** `*.v<N>.workflow.json`. Si el cambio es incompatible, crear
   `v(N+1)` en vez de sobrescribir.
4. Commit + PR.

## Comandos

```
npm install
npm test
npm run typecheck
```

## Decisión arquitectónica: por qué viven aquí y no en `decants-infrastructure/`

Los workflows viven en `decants-agents/` (este repo) y no en
`decants-infrastructure/` porque:

- Las dependencias **en runtime** de los workflows (postgres-agents,
  browserless, las credenciales que n8n debe poder alcanzar) viven en
  este repo. Acoplar el workflow al stack que lo soporta evita drift
  entre "el flujo dice X" y "la infra expone Y".
- Los schemas Zod versionan el **contrato del output del agente**. Ese
  contrato solo lo consume el sistema agéntico (este repo) — la infra
  no lo necesita.
- `decants-infrastructure/` queda dedicado a Terraform y configuración
  cloud, sin lógica de aplicación.
