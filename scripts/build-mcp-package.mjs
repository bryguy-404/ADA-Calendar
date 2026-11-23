/** Build a public, dependency-contained adapter. No environment/session/config is copied. */
import {build} from 'esbuild';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const version='1.3.0',root=process.cwd(),out=path.join(root,'.data/mcp-package',`ada-calendar-mcp-${version}`);
mkdirSync(out,{recursive:true});
const licenses=new Map();
for(const [name,entry] of Object.entries({server:'scripts/mcp.ts',login:'scripts/mcp-login.ts',verify:'scripts/mcp-package/verify.ts'})) {
  const result=await build({entryPoints:[entry],outfile:path.join(out,name+'.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',metafile:true,legalComments:'eof'});
  for(const input of Object.keys(result.metafile.inputs).filter(p=>p.includes('node_modules/'))) {
    let dir=path.dirname(path.resolve(input));
    while(dir!==path.dirname(dir)&&(!existsSync(path.join(dir,'package.json'))||!JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).name))dir=path.dirname(dir);
    if(licenses.has(dir))continue;
    const manifest=JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8'));
    const license=['LICENSE','LICENSE.md','LICENSE.txt','license','license.md'].find(f=>existsSync(path.join(dir,f)));
    if(!license)throw new Error(`No bundled license found for ${manifest.name}`);
    licenses.set(dir,`${manifest.name}@${manifest.version}\n${readFileSync(path.join(dir,license),'utf8')}`);
  }
}
writeFileSync(path.join(out,'THIRD_PARTY_NOTICES.txt'),[...licenses.values()].join('\n\n-----\n\n'));
copyFileSync('scripts/mcp-package/install.mjs',path.join(out,'install.mjs'));
copyFileSync('scripts/mcp-package/ada.mjs',path.join(out,'ada.mjs'));
copyFileSync('docs/MCP_TEAMMATE_SETUP.md',path.join(out,'README.md'));
const files=['server.cjs','login.cjs','verify.cjs','install.mjs','ada.mjs','THIRD_PARTY_NOTICES.txt','README.md'];
writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version,node: '>=22.22.0',files:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(path.join(out,file))).digest('hex')]))},null,2)+'\n');
const archive=out+'.tgz';
execFileSync('tar',['-czf',archive,'-C',path.dirname(out),path.basename(out)]);
writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex')+'  '+path.basename(archive)+'\n');
console.log(archive);
