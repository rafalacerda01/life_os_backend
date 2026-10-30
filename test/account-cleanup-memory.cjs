"use strict";
const {Timestamp} = require("firebase-admin/firestore");
function copy(v) {
  if (v instanceof Timestamp) return v;
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)]));
  return v;
}
class MemoryFirestore {
  constructor() {
    this.projectId="demo-life-os-p1"; this.databaseId="(default)";
    this.docs=new Map(); this.versions=new Map(); this.serial=0;
    this.commits=[]; this.hooks={}; this.conflicts=0;
  }
  put(path,data) {
    if(data===undefined)this.docs.delete(path);else this.docs.set(path,copy(data));
    this.versions.set(path,++this.serial);
  }
  doc(path) {
    const db=this;
    return {path,collection:name=>db.collection(path+"/"+name),
      get:async()=>db.snapshot(path),
      listCollections:async()=>[...new Set([...db.docs.keys()]
        .filter(p=>p.startsWith(path+"/")).map(p=>p.slice(path.length+1).split("/")[0]))]
        .map(name=>db.collection(path+"/"+name))};
  }
  collection(path) {
    const db=this;
    return {path,doc:id=>db.doc(path+"/"+id),
      listDocuments:async()=>[...new Set([...db.docs.keys()]
        .filter(p=>p.startsWith(path+"/"))
        .map(p=>path+"/"+p.slice(path.length+1).split("/")[0]))].map(p=>db.doc(p))};
  }
  snapshot(path,docs=this.docs,versions=this.versions) {
    return {ref:this.doc(path),exists:docs.has(path),
      updateTime:docs.has(path)?Timestamp.fromMillis(versions.get(path)||0):undefined,
      data:()=>copy(docs.get(path))};
  }
  async runTransaction(callback) {
    for(let attempt=0;attempt<12;attempt++){
      const docs=new Map(this.docs),versions=new Map(this.versions),reads=new Set(),writes=[];
      const tx={get:async ref=>{
        if(writes.length)throw Error("read after write");
        reads.add(ref.path);return this.snapshot(ref.path,docs,versions);
      }};
      for(const type of ["create","set","update","delete"])tx[type]=(ref,data)=>writes.push({type,path:ref.path,data:copy(data)});
      const result=await callback(tx);
      await this.hooks.beforeCommit?.({writes,attempt});
      if([...reads].some(p=>this.versions.get(p)!==versions.get(p))){this.conflicts++;continue;}
      for(const w of writes){
        if(w.type==="create"&&this.docs.has(w.path))throw Error("existing create");
        if(w.type==="update"&&!this.docs.has(w.path))throw Error("missing update");
      }
      for(const w of writes)this.put(w.path,w.type==="delete"?undefined:
        w.type==="update"?{...this.docs.get(w.path),...w.data}:w.data);
      this.commits.push(writes);
      await this.hooks.afterCommit?.({writes,attempt});
      return result;
    }
    throw Error("retry exhausted");
  }
}
module.exports={MemoryFirestore};
