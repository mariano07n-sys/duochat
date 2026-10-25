# DuoChat

Chat temps réel entre développeurs, directement dans VS Code. Par défaut, aucun serveur : les messages chiffrés de bout en bout passent par des relais publics Nostr.

- `extension/` : l'extension VS Code (documentation complète dans [extension/README.md](extension/README.md)).
- `supabase/duochat.sql` : script SQL de l'historique pour l'option avancée Supabase (recopié dans `extension/README.md`).
- `server/` : le relais WebSocket auto-hébergé (option avancée).
- `render.yaml` : blueprint pour déployer le relais sur Render en quelques clics.

## Développement

```bash
npm install
npm run build      # bundle de l'extension
npm run typecheck
npm test           # tests du relais
npm run server     # relais local sur ws://localhost:8787
npm run package    # produit extension/duochat-<version>.vsix
```

## Publication sur le Marketplace

1. Incrémentez `version` dans `extension/package.json` et complétez `extension/CHANGELOG.md`.
2. `npm run package`.
3. Envoyez le `.vsix` sur https://marketplace.visualstudio.com/manage (éditeur `duochat` → *New extension* / *Update*).
