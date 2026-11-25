# Picqer cut-offmonitor

Een kleine **alleen-lezen** service die controleert of onze distributiepartner orders op tijd verwerkt
volgens de cut-offafspraak. De service draait op Cloudflare Workers en is in Claude aan te sluiten als
**custom connector** (remote MCP). Een dagelijkse Claude-taak roept de controle aan en maakt het rapport.

Live: `https://picqer-monitor.jurrian-6d3.workers.dev` (controle: `/health` toont `picqer-cutoff-monitor ok`).

De service doet alleen `GET`-verzoeken naar de beperkte Picqer Fulfilment API
(`/orders`, `/orders/{id}`, `/backorders`, `/picklists/{id}/shipments`) en bewaart alleen
het ordernummer, de referentie, het land, statussen en tijdstempels. Geen namen of adressen.

## SLA-regels

Staan in [`config/sla.json`](config/sla.json). Samengevat (bevestigd 25-11-2026):

| | |
|---|---|
| Cut-off (werkdagen, Europe/Amsterdam) | NL 23:59, BE 22:59, overige landen 20:59. De hele cut-offminuut telt mee. |
| Startmoment | Ontvangst in Picqer (`order.created`) |
| Vóór cut-off | Dezelfde werkdag uiterlijk 23:59:59 verwerkt |
| Na cut-off | Volgende werkdag uiterlijk 23:59:59 verwerkt |
| Weekend / sluitingsdag | Telt als ontvangen vóór de cut-off op de eerstvolgende werkdag |
| Verwerkt | Status 'Processed'. Gemeten als het moment dat de laatste picklijst is gesloten (`closed_at`), gerapporteerd als *geregistreerd in Picqer* (**nog te bevestigen in de steekproef**) |
| Deelzendingen | Komen niet voor; de hele order moet verwerkt zijn |
| Backorder | Klok start bij voorraad. Niet zichtbaar in de API → *onvoldoende gegevens*. Nog wachtend → *buiten scope* |
| Geannuleerd | Buiten scope |

Regels met `"confirmed": false` worden in elk rapport als onbevestigd genoemd.

**Sluitingsdagen** staan in [`config/closing-days.json`](config/closing-days.json). Vul die twee keer per jaar aan
met de kalender van de partner (of vraag Claude om dat te doen).

## Uitkomsten per order

`op tijd`, `te laat verwerkt`, `nog open na deadline`, `deadline nog niet verstreken`,
`onvoldoende gegevens`, `buiten scope`. Per order worden de toegepaste regel, de gebruikte tijdstempels en
de reden bewaard. Percentage op tijd = op tijd / (op tijd + te laat verwerkt + nog open na deadline).

Elke order telt in de run waarin de deadline verstrijkt. Eerder gemelde open orders worden elke run
opnieuw bekeken; wijzigingen staan apart in het rapport. Een API-fout of onvolledige ophaling laat het
controletijdstip staan, zodat de volgende succesvolle run de periode inhaalt.

## Tools in de connector

| Tool | Doel |
|---|---|
| `run_cutoff_check` | De controle. Standaard proefrun (`dry_run: true`, niets opgeslagen). De dagelijkse taak gebruikt `dry_run: false`. Eerste run: geef `from` mee. |
| `inspect_order` | Eén order bekijken (ordernummer of referentie): ruwe tijdstempels, deadline, uitkomst, zendingen. |
| `sample_orders` | Kleine steekproef van recente orders met beoordeling. |
| `get_monitor_status` | Laatste succesvolle controle, open orders, sluitingsdagen, regels. |

## Installatie (eenmalig)

1. **Cloudflare koppelen aan GitHub**: Worker `picqer-monitor` → *Settings* → *Build* → *Connect* →
   GitHub, repository `picqer-monitor`, branch `main`. Elke wijziging op `main` wordt automatisch gepubliceerd.
   De opslag (KV) wordt bij de eerste build automatisch aangemaakt.
2. **Geheimen instellen**: Worker → *Settings* → *Variables and Secrets* → *Add*, type **Secret**:
   - `PICQER_BASE_URL`: `https://<account>.picqer.com/api/v1` (het Picqer-account van de partner)
   - `PICQER_API_KEY`: de Fulfilment API-sleutel
   - `MCP_PATH_TOKEN`: een lange willekeurige reeks van minimaal 32 letters/cijfers
3. **Connector toevoegen in Claude**: *Settings* → *Connectors* → *Add custom connector*.
   URL: `https://picqer-monitor.jurrian-6d3.workers.dev/mcp/<MCP_PATH_TOKEN>`.
   Behandel deze URL als een wachtwoord.

## Limieten

Het gratis Workers-abonnement staat maximaal 50 externe verzoeken en 10 ms rekentijd per aanroep toe.
`MAX_API_REQUESTS` staat daarom op 45. Is het ordervolume te groot, dan meldt de run dat als mislukt
(gegevens onvolledig) en is het betaalde Workers-abonnement nodig; zet `MAX_API_REQUESTS` dan hoger.

## Ontwikkelen

```bash
npm install
npm test          # rekenregels, planning/inhalen, MCP en Picqer-client
npx wrangler dev  # lokaal draaien (geheimen in .dev.vars, niet committen)
```

## Volgende stap: vervoerdersperformance

Per verwerkte order bewaart de controle de koppeling order → picklijst → zending → vervoerder → trackingcode
(KV-sleutels `parcels:*`). Een latere uitbreiding gebruikt die om tijd tot eerste scan, transittijd en
levering op tijd te meten.
