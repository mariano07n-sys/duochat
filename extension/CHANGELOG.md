# Changelog

## 0.3.0 — 2026-10-24

- **Zéro configuration** : *Créer un salon* fonctionne en un clic, sans compte ni serveur. DuoChat passe par des relais publics Nostr redondants.
- **Chiffrement de bout en bout** (AES-256-GCM, clé dérivée de la clé du salon) : les relais ne voient que des données chiffrées.
- L'invitation pour le réseau public ne contient que la clé du salon.
- Supabase et le relais auto-hébergé passent dans *Options avancées*.

## 0.2.0 — 2026-10-24

- **Supabase par défaut** : plus besoin d'héberger un serveur. DuoChat utilise Supabase Realtime (messages, présence, frappe) et un script SQL pour l'historique.
- **Invitations** : un code `duochat:…` contient tout ce qu'il faut pour rejoindre un salon (*Créer ou rejoindre un salon*, *Copier l'invitation du salon*).
- Le relais auto-hébergé reste disponible (URL `wss://`).
- Nécessite VS Code 1.101 ou plus récent.

## 0.1.0 — 2026-10-24

Première version publique.

- Chat temps réel dans la barre latérale, historique des 200 derniers messages.
- Présence des participants et indicateur de frappe.
- Partage de `fichier:ligne` depuis l'éditeur, ouverture en un clic chez le destinataire.
- Notifications VS Code et compteur de non-lus dans la barre d'état.
- Sélecteur d'emoji.
- Reconnexion automatique avec conservation du brouillon.
- Relais WebSocket auto-hébergeable (Node.js, Docker, blueprint Render).
