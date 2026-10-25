# DuoChat

**Discutez avec votre collaborateur sans quitter VS Code.**
DuoChat ajoute un chat temps réel dans la barre latérale : messages, présence, indicateur de frappe et partage de `fichier:ligne` en un clic. Fini les allers-retours entre l'éditeur et WhatsApp.

**Rien à installer, aucun compte, aucun serveur** : créez un salon, envoyez l'invitation, c'est tout. Les messages sont **chiffrés de bout en bout** avec la clé du salon.

## Fonctionnalités

- **Chat temps réel** dans la barre d'activité, avec l'historique récent du salon.
- **Chiffrement de bout en bout** (AES-256-GCM) : seuls les détenteurs de l'invitation peuvent lire les messages.
- **Présence** : qui est en ligne, et « Alice écrit… » pendant la frappe.
- **Partage de position** : clic droit dans l'éditeur → *DuoChat : Partager le fichier et la ligne courantes*. Votre collaborateur ouvre le fichier à la bonne ligne en un clic (chemin relatif au workspace).
- **Invitation en un clic** : un seul code `duochat:…` à envoyer à votre collaborateur.
- **Notifications VS Code** quand un message arrive et que le chat n'est pas visible, et un compteur de non-lus dans la barre d'état.
- **Sélecteur d'emoji** intégré.
- **Reconnexion automatique** sans perte du brouillon en cours.

## Démarrage (30 secondes)

1. **Vous** : ouvrez la vue **DuoChat** dans la barre d'activité → **Créer ou rejoindre un salon** → **Créer un salon**, puis choisissez un pseudo.
   L'invitation (`duochat:…`) est copiée dans le presse-papiers : envoyez-la **en privé** à votre collaborateur.
2. **Votre collaborateur** : vue **DuoChat** → **Créer ou rejoindre un salon** → **Rejoindre avec une invitation**, collez le code et choisissez un pseudo.

Vous discutez. Vous pouvez recopier l'invitation à tout moment avec l'icône « personne + » de la vue ou la commande *DuoChat : Copier l'invitation du salon*.

> L'invitation contient la clé du salon : toute personne qui la possède peut lire et écrire dans le salon. Transmettez-la par un canal privé. Pour changer de salon, créez-en un nouveau.

## Comment ça marche

Par défaut, DuoChat utilise le **réseau public [Nostr](https://nostr.com)** comme simple boîte aux lettres : plusieurs relais publics et gratuits (damus.io, nos.lol, primal.net, nostr.mom, snort.social) transportent les messages en parallèle, ce qui évite de dépendre d'un seul serveur.

- La clé du salon ne quitte jamais votre machine. Elle sert à dériver (HKDF-SHA256) un identifiant de salon opaque et une clé AES-256-GCM qui chiffre chaque message, signal de présence et indicateur de frappe.
- Les relais ne voient que des données chiffrées, l'identifiant opaque du salon, l'horodatage et l'adresse IP de connexion.
- L'historique (200 derniers messages affichés) dépend de la durée de conservation des relais publics : il est fourni **au mieux**, sans garantie.

Besoin d'un historique garanti ou d'une infrastructure maîtrisée ? Voir les [options avancées](#options-avancées).

## Options avancées

Dans **Créer ou rejoindre un salon** → **Options avancées**, vous pouvez utiliser votre propre infrastructure au lieu du réseau public. L'invitation générée embarque alors l'adresse du serveur : votre collaborateur la rejoint de la même façon, en la collant.

Dans ces deux modes, les messages ne sont **pas chiffrés de bout en bout** : l'administrateur du serveur peut lire l'historique stocké.

### Supabase (historique garanti, gratuit)

1. Créez un projet gratuit sur [supabase.com](https://supabase.com/dashboard).
2. Dans **SQL Editor**, exécutez le [script SQL ci-dessous](#script-sql) (crée la table de l'historique et deux fonctions ; ré-exécutable sans risque).
3. Dans **Options avancées**, saisissez l'URL du projet (`https://<identifiant>.supabase.co`) et la **clé publique** `sb_publishable_…` (ou l'ancienne clé `anon`). **Jamais** la clé `secret` / `service_role`.

Le salon est identifié par l'empreinte SHA-256 de sa clé ; la table n'est accessible qu'à travers les deux fonctions du script (RLS activé, aucun droit direct). Chaque salon conserve ses 500 derniers messages.

#### Script SQL

```sql
-- DuoChat : historique des messages.
-- À exécuter une seule fois dans Supabase > SQL Editor. Ré-exécutable sans risque.

create table if not exists public.duochat_messages (
  id uuid primary key,
  room text not null check (room ~ '^[0-9a-f]{64}$'),
  user_id text not null,
  name text not null,
  color text not null,
  kind text not null check (kind in ('text', 'location')),
  body text not null,
  meta jsonb,
  ts bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists duochat_messages_room_ts on public.duochat_messages (room, ts desc);

-- Aucun accès direct à la table : tout passe par les deux fonctions ci-dessous.
alter table public.duochat_messages enable row level security;
revoke all on public.duochat_messages from anon, authenticated;

create or replace function public.duochat_history(p_room text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(m.msg order by m.ts), '[]'::jsonb)
  from (
    select ts,
           jsonb_strip_nulls(jsonb_build_object(
             't', 'msg', 'id', id, 'userId', user_id, 'name', name, 'color', color,
             'kind', kind, 'text', body, 'meta', meta, 'ts', ts
           )) as msg
    from public.duochat_messages
    where room = p_room
    order by ts desc
    limit 200
  ) m;
$$;

create or replace function public.duochat_post(p_room text, p_message jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := coalesce(p_message->>'kind', 'text');
  v_name text := left(btrim(coalesce(p_message->>'name', '')), 32);
  v_user text := left(btrim(coalesce(p_message->>'userId', '')), 64);
  v_color text := p_message->>'color';
  v_body text := left(btrim(coalesce(p_message->>'text', '')), 4000);
  v_meta jsonb;
  v_file text;
  v_line integer;
  v_ts bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  v_cutoff bigint;
begin
  if p_room is null or p_room !~ '^[0-9a-f]{64}$' then
    raise exception 'duochat: salon invalide' using errcode = '22023';
  end if;
  if v_kind not in ('text', 'location') or v_name = '' or v_user = '' then
    raise exception 'duochat: message invalide' using errcode = '22023';
  end if;
  if v_color is null or v_color !~ '^#[0-9a-fA-F]{6}$' then
    v_color := '#22d3ee';
  end if;

  if v_kind = 'location' then
    v_file := left(btrim(coalesce(p_message->'meta'->>'file', '')), 512);
    v_line := case
      when (p_message->'meta'->>'line') ~ '^[0-9]{1,7}$' then (p_message->'meta'->>'line')::integer
    end;
    if v_file = '' or v_line is null or v_line < 1 or v_line > 1000000 then
      raise exception 'duochat: référence invalide' using errcode = '22023';
    end if;
    v_meta := jsonb_build_object('file', v_file, 'line', v_line);
    v_body := v_file || ':' || v_line;
  elsif v_body = '' then
    raise exception 'duochat: message vide' using errcode = '22023';
  end if;

  insert into public.duochat_messages (id, room, user_id, name, color, kind, body, meta, ts)
  values ((p_message->>'id')::uuid, p_room, v_user, v_name, v_color, v_kind, v_body, v_meta, v_ts)
  on conflict (id) do nothing;

  -- Conserver les 500 derniers messages par salon.
  select ts into v_cutoff
  from public.duochat_messages
  where room = p_room
  order by ts desc
  offset 499 limit 1;
  if v_cutoff is not null then
    delete from public.duochat_messages where room = p_room and ts < v_cutoff;
  end if;
end;
$$;

revoke execute on function public.duochat_history(text) from public;
revoke execute on function public.duochat_post(text, jsonb) from public;
grant execute on function public.duochat_history(text) to anon, authenticated;
grant execute on function public.duochat_post(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
```

### Relais auto-hébergé

Un petit relais WebSocket Node.js (dossier `server/` du dépôt source). Dans **Options avancées**, saisissez son URL `wss://…`.

- **Render (gratuit)** : **New → Blueprint** sur le dépôt (le fichier `render.yaml` configure tout), ou **New → Web Service** avec *Root Directory* `server`, *Build Command* `npm install --omit=dev`, *Start Command* `node src/index.js`. Le service gratuit se met en veille et perd l'historique à chaque redémarrage.
- **Docker** (Fly.io, VPS, NAS…) :

  ```bash
  cd server
  docker build -t duochat-relay .
  docker run -d --name duochat -p 8787:8787 -v duochat-data:/data --restart unless-stopped duochat-relay
  ```

- **Local** : `cd server && npm install && npm start` (écoute sur `ws://0.0.0.0:8787`).

Variables du relais : `PORT` (défaut `8787`), `HOST` (défaut `0.0.0.0`), `DATA_DIR` (dossier de l'historique ; vide = mémoire seulement). Le relais expose `GET /health`. Placez-le derrière HTTPS et utilisez `wss://`.

## Paramètres

| Paramètre                | Défaut   | Description                                                                              |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `duochat.serverUrl`      | *(vide)* | Vide = réseau public chiffré. Sinon URL Supabase (`https://…`) ou du relais (`wss://…`). |
| `duochat.displayName`    | *(vide)* | Pseudo affiché. Vide = nom d'utilisateur du système.                                     |
| `duochat.notifications`  | `true`   | Notification quand un message arrive et que le chat n'est pas visible.                   |
| `duochat.autoConnect`    | `true`   | Connexion automatique au démarrage si un salon est configuré.                            |

La clé du salon et la clé Supabase ne sont **pas** stockées dans les paramètres : elles sont conservées dans le stockage sécurisé de VS Code (`SecretStorage`).

## Commandes

| Commande                                              | Description                                           |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `DuoChat : Ouvrir le chat`                            | Affiche la vue DuoChat.                               |
| `DuoChat : Créer ou rejoindre un salon`               | Création en un clic, invitation ou options avancées.  |
| `DuoChat : Copier l'invitation du salon`              | Copie le code `duochat:…` à envoyer.                  |
| `DuoChat : Se connecter` / `Se déconnecter`           | Contrôle manuel de la connexion.                      |
| `DuoChat : Partager le fichier et la ligne courantes` | Envoie la position du curseur dans le chat.           |

## Dépannage

- **« Réseau DuoChat injoignable »** : aucun relais public n'a répondu (pare-feu d'entreprise, proxy, absence de réseau). DuoChat réessaie automatiquement ; si le blocage persiste, utilisez une [option avancée](#options-avancées).
- **Ancien message manquant** : en mode public, l'historique dépend des relais. Pour un historique garanti, utilisez Supabase.
- **« Clé Supabase refusée »** : utilisez la clé *publishable* / *anon* du bon projet.
- **« Historique désactivé »** (Supabase) : le script SQL n'a pas été exécuté dans ce projet. Exécutez-le, puis reconnectez-vous.
- **« Projet Supabase indisponible »** : les projets gratuits sont mis en pause après une semaine d'inactivité. Relancez-le depuis le tableau de bord ; DuoChat se reconnecte tout seul.

## Sécurité et confidentialité

- Pas de compte, pas de télémétrie. Les messages ne transitent que par les relais du mode choisi.
- Mode public : contenu chiffré de bout en bout ; les relais voient l'identifiant opaque du salon, les horodatages, la taille des messages et votre adresse IP.
- Chaque message est signé avec une clé jetable générée à chaque session : aucune identité Nostr persistante n'est créée.
- Les pseudos ne sont visibles que par les membres du salon (ils sont chiffrés avec le message).

## Licence

MIT
