# Approved CRM / Calendar client matches

Prepared September 15, 2026 from the live client directories. Bryan approved all 19 pairs below, including both clarification pairs, on September 15. All 19 mappings are now installed through the owner-authenticated Calendar setup on connection `e154f3c1-35e0-4cb7-9387-b31d14435a4f`. Read-only hosted verification confirms the exact IDs and the owner's recorded confirmation for every pair. The connection remains disabled; no new clients were created.

## Approved matches

| CRM name | Calendar name |
| --- | --- |
| Alpha Dog Agency | Alpha Dog Agency |
| Balsam Dental | Balsam Dental |
| Becht Pride | Becht Pride |
| Drive & Shine | Drive and Shine |
| Emily Stout DDS | Emily Stout |
| Green Improvements | Green Improvements |
| Growing Kids Learning Center | Growing Kids |
| Higher Ground Tree Care | Higher Ground Tree Care |
| Laville Barber Supply | Laville Barber |
| Middletown Family Dentistry | Middletown Family Dentistry |
| Oral Surgery Michiana | Oral Surgery Michiana |
| Periolat Family Dentistry | Periolat Family Dentistry |
| Point Guard University | Point Guard University |
| Pura Vida Chicas | Pura Vida Chicas |
| Rise N Roll | Rise'n Roll |
| Selking Performance | Selking Performance |
| Tech Tyler MSP | Tech Tyler |

## Clarification pairs — also approved

| CRM name | Calendar name |
| --- | --- |
| United Way | United Way Of St. Joseph |
| Z Roofing & Construction | Z Roofing and Solutions |

Bryan confirmed that both pairs refer to the same clients.

## CRM clients with no proposed Calendar match

Acts Management Dental Group, Curtis Products, Eric Moore Dental, Family Foot Care, Linden Grill, London Stoneworks, Marvin Enterprises, Michiana Battery, Midtown Dental Care, Midwest Enterprises, Mimmo's Pizza, Platinum Cargo, Seald Roofing, The Trainer Pack, Wolf Family Dentistry, and Zent Family Dentistry.

Bryan can identify an existing Calendar client or choose to add a new one. Do not silently match a parent dental group to an individual practice or create clients from guesses. These clients cannot use integrated booking until an owner-confirmed match exists.

The exact client IDs, owner approval and installation status are recorded in [the mapping records](CRM_CLIENT_MATCH_PROPOSALS.json). All 19 are approved and installed. Clients without a proposed match remain unresolved.

## Connection and pilot

The proposed server connection uses CRM website `https://alphadogcrm.com`, CRM Auth project `https://lyopwmiybrhmxbmjjopv.supabase.co`, its existing public/publishable key, and verified agency domain `alphadogagency.com`. Once issued, the private connection credential belongs only in the CRM server's Railway variables; it must not be put in this document, source control, chat, logs, task records or browser storage.

The connection and mappings are installed with access disabled. Bryan had saved the original key and has now staged it in CRM's protected Railway configuration; no rotation is needed or has occurred. All five integration settings are staged but not deployed. One extra newline in the pasted key must be removed before deployment. After complete configuration, agree on a disposable live task, open work slot and test-notification recipient before enabling a controlled pilot. Retain the established owner-only approval and protected-time rules.
