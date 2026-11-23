import {readFileSync,mkdirSync,copyFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<22))throw new Error('Install Node 22.22+ or Node 24 LTS first.');
const source=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--directory'&&path.isAbsolute(args[1])))throw new Error('Usage: node install.mjs [--directory /absolute/private/install-root]');
const root=args[1]||path.join(homedir(),'.local','share','ada-calendar-mcp');
const manifest=JSON.parse(readFileSync(path.join(source,'manifest.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version))throw new Error('Invalid release version.');
const destination=path.join(root,'versions',manifest.version);
if(existsSync(destination))throw new Error('This version already exists. Keep it for rollback or choose a separate installation root.');
for(let p=root;p!==path.dirname(p);p=path.dirname(p))if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Choose a private non-symlink installation directory.');
for(const [name,expected] of Object.entries(manifest.files)) {
  if(path.basename(name)!==name||lstatSync(path.join(source,name)).isSymbolicLink())throw new Error('Unsafe release file.');
  if(createHash('sha256').update(readFileSync(path.join(source,name))).digest('hex')!==expected)throw new Error('Release checksum failed. Download again.');
}
mkdirSync(destination,{recursive:true,mode:0o700});
for(const name of [...Object.keys(manifest.files),'manifest.json'])copyFileSync(path.join(source,name),path.join(destination,name));
const config={type:'stdio',command:process.execPath,args:[path.join(destination,'ada.mjs'),'start']};
writeFileSync(path.join(destination,'claude-mcp.json'),JSON.stringify({mcpServers:{'ada-calendar-requester':config}},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({installed:destination,next:[`node "${path.join(destination,'ada.mjs')}" login`,`node "${path.join(destination,'ada.mjs')}" verify YYYY-MM-DD`,`node "${path.join(destination,'ada.mjs')}" connect`],configurationChanged:false},null,2));
