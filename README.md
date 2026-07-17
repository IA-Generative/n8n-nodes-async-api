# @minint/n8n-nodes-async-api

Nœuds [n8n](https://n8n.io) pour les services IA **BRIO** (`async-api`) : soumettre des tâches
à un service, suivre leur avancement et récupérer les résultats, directement depuis un workflow n8n.

> Statut : **socle** (#484). Les opérations sont livrées dans les tickets suivants de
> l'EPIC [`[N8N] Intégration dans des noeuds N8N`](https://github.com/IA-Generative/async-api/issues/218).

## Contenu

- **Credential `AsyncTaskAPI (BRIO)`** : `Base URL` + `Client ID` + `Client Secret`
  (authentification HTTP Basic). Le bouton **« Tester »** valide réellement les identifiants
  via `GET /v1/me`.
- **Nœud `BRIO — Services IA`** : opérations `Soumettre et attendre`, `Soumettre une tâche`,
  `Récupérer une tâche`, `Envoyer un fichier` (implémentation progressive).

## Développement

```bash
pnpm install
pnpm build        # tsc + copie des icônes
pnpm lint
pnpm dev          # tsc --watch (hot-reload en dev)
```

### Tester en local dans n8n

Pointer une credential sur le **staging** puis exécuter un workflow. Voir la doc n8n sur les
nœuds communautaires en développement (montage du `dist/` dans `~/.n8n/custom`).

## Publication

Package **scoped `@minint/`** publié sur le **Nexus** (Scaleway + DSO MI), puis intégré à
l'image n8n via [`n8n-image`](https://github.com/IA-Generative/n8n-image) (`nodes/package.json`).
Voir tickets #481 (CI Nexus) et #482 (image).

## Licence

[MIT](./LICENSE.md)
