# CRM / Calendar client matches for Bryan's review

Prepared September 15, 2026 from the live client directories. These are proposals only: no mappings or new clients have been created. Bryan must confirm the actual client identities before bookings are enabled.

## Proposed matches

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

## Two names needing particular clarification

| CRM name | Possible Calendar name |
| --- | --- |
| United Way | United Way Of St. Joseph |
| Z Roofing & Construction | Z Roofing and Solutions |

Confirm whether each pair is the same organization. A similar name alone is not sufficient.

## CRM clients with no proposed Calendar match

Acts Management Dental Group, Curtis Products, Eric Moore Dental, Family Foot Care, Linden Grill, London Stoneworks, Marvin Enterprises, Michiana Battery, Midtown Dental Care, Midwest Enterprises, Mimmo's Pizza, Platinum Cargo, Seald Roofing, The Trainer Pack, Wolf Family Dentistry, and Zent Family Dentistry.

Bryan can identify an existing Calendar client or choose to add a new one. Do not silently match a parent dental group to an individual practice or create clients from guesses. These clients cannot use integrated booking until an owner-confirmed match exists.

The exact client IDs are recorded in [the mapping proposals](CRM_CLIENT_MATCH_PROPOSALS.json). All entries remain proposals until Bryan confirms them.

## Connection and pilot

The proposed server connection uses CRM website `https://alphadogcrm.com`, CRM Auth project `https://lyopwmiybrhmxbmjjopv.supabase.co`, its existing public/publishable key, and verified agency domain `alphadogagency.com`. The newly issued private connection credential belongs only in the CRM server's Railway variables; it must not be put in this document, source control, chat, logs, task records or browser storage.

Create the connection disabled. After configuration and approved client matches, agree on a disposable live task, open work slot and test-notification recipient before enabling a controlled pilot. Retain the established owner-only approval and protected-time rules.
