// Fictional records and schema changes roll back together. No hosted credentials or mail.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const args=['exec','-i','supabase_db_ada-calendar','psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'];
const installed=execFileSync('docker',[...args,'-At'],{input:"select to_regclass('public.crm_intakes') is not null;",encoding:'utf8'}).trim()==='t';
let migration=readFileSync(new URL('../supabase/migrations/202610200001_crm_unscheduled_intake.sql',import.meta.url),'utf8');
if(installed)migration=migration.slice(migration.indexOf('create function public.receive_crm_intake')).replace('create function','create or replace function');
const sql='begin;\n'+migration+'\n'+readFileSync(new URL('./crm-intake-db-test.sql',import.meta.url),'utf8')+'\nrollback;';
execFileSync('docker',['exec','-i','supabase_db_ada-calendar','psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','inherit','inherit']});
