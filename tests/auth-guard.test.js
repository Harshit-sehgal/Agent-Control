/** Workspace ownership cannot be given away when there is nobody left to run it.
 *
 * The owner role is the only one that can grant the owner role (`updateUser`
 * refuses to grant a role at or above the actor's own), so an owner who demotes
 * themselves leaves a workspace whose settings, restores and workspace
 * management nobody can reach again — a one-click, unrecoverable lockout.
 *
 * This is the module-level half: `Auth.updateUser` must refuse with a 409 (the
 * status `routes-account.js` turns into the response) and must say why. The
 * HTTP-level counterpart belongs to tests/authz-matrix.test.js; this file does
 * not need a server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {Auth,DEFAULT_WORKSPACE} from '../src/auth.js';

const OWNER_PASSWORD='owner-password-1';

async function harness(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-owner-'));
  const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
  const auth=new Auth(store);
  auth.ensureBootstrap(OWNER_PASSWORD);
  const login=auth.login({password:OWNER_PASSWORD});
  assert.equal(login.ok,true,'bootstrap owner must be able to sign in');
  const actor=auth.session(login.sessionId);
  assert.equal(actor.role,'owner');
  return {dir,store,auth,actor,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}

const roleOf=(store,userId)=>store.get('SELECT role FROM workspace_members WHERE user_id=? AND workspace_id=?',userId,DEFAULT_WORKSPACE)?.role;

/** A second owner, short of a second login. */
function addSecondOwner(store,auth,actor){
  const created=auth.createUser(actor,{email:'second.owner@example.test',password:'second-owner-password-1',role:'admin'});
  store.run('UPDATE workspace_members SET role=? WHERE user_id=? AND workspace_id=?','owner',created.id,DEFAULT_WORKSPACE);
  return created;
}

test('the last owner cannot demote themselves',async()=>{
  const {store,auth,actor,cleanup}=await harness();
  try{
    // `updateUser` is synchronous; `assert.rejects` expects a promise and would
    // report its own ERR_INVALID_RETURN_VALUE instead of the refusal.
    assert.throws(()=>auth.updateUser(actor,actor.userId,{role:'admin'}),error=>{
      assert.equal(error.status,409,`expected a 409 conflict, got ${error.status}: ${error.message}`);
      assert.match(error.message,/last owner|only owner/i,'the refusal has to name the reason, not just "forbidden"');
      return true;
    });
    assert.equal(roleOf(store,actor.userId),'owner','a refused demotion must not change the role');
    // The same call for someone else still works, so the guard is about the last
    // owner and not a blanket freeze on user management.
    const member=auth.createUser(actor,{email:'member@example.test',password:'member-password-1',role:'member'});
    auth.updateUser(actor,member.id,{role:'viewer'});
    assert.equal(roleOf(store,member.id),'viewer');
  }finally{ await cleanup(); }
});

test('an owner may step down when another owner remains',async()=>{
  const {store,auth,actor,cleanup}=await harness();
  try{
    addSecondOwner(store,auth,actor);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND role=?',DEFAULT_WORKSPACE,'owner').n,2);

    const updated=auth.updateUser(actor,actor.userId,{role:'admin'});

    assert.equal(updated.role,'admin','with a second owner in place the demotion is allowed');
    assert.equal(roleOf(store,actor.userId),'admin');
    assert.equal(store.get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND role=?',DEFAULT_WORKSPACE,'owner').n,1,
      'exactly one owner must be left, never zero');
  }finally{ await cleanup(); }
});

test('the guard is about ownership, not about demoting yourself',async()=>{
  const {store,auth,actor,cleanup}=await harness();
  try{
    const admin=auth.createUser(actor,{email:'admin@example.test',password:'admin-password-1',role:'admin'});
    const login=auth.login({email:'admin@example.test',password:'admin-password-1'});
    assert.equal(login.ok,true);
    const adminActor=auth.session(login.sessionId);

    auth.updateUser(adminActor,admin.id,{role:'member'});

    assert.equal(roleOf(store,admin.id),'member','an admin demoting themselves must still be allowed');
    assert.equal(roleOf(store,actor.userId),'owner','and that must not touch the owner');
  }finally{ await cleanup(); }
});
