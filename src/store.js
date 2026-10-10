import fs from 'node:fs/promises';
import path from 'node:path';
import {initialState} from './core.js';

export class JsonStore {
  constructor(filename){this.filename=filename;this.state=null;this.serial=Promise.resolve();}
  async init(){
    await fs.mkdir(path.dirname(this.filename),{recursive:true});
    try {this.state=JSON.parse(await fs.readFile(this.filename,'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;this.state=initialState();await this.persist();}
    return this;
  }
  read(){return structuredClone(this.state);}
  async persist(){const t=this.filename+'.tmp';await fs.writeFile(t,JSON.stringify(this.state,null,2),{mode:0o600});await fs.rename(t,this.filename);}
  update(fn){
    const op=this.serial.then(async()=>{
      const next=structuredClone(this.state); const result=await fn(next);
      this.state=next;await this.persist();return result;
    });
    this.serial=op.catch(()=>{});return op;
  }
}
