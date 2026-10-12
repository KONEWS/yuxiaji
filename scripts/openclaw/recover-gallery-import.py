#!/usr/bin/env python3
"""Resume the 2026-10 historical imports on the OpenClaw host.

Default mode reads only. Execute one bounded batch with:
    python3 recover-gallery-import.py 80 --execute --max-uploads 3

The installed Skill resolves credentials and source URLs locally. Private
snapshots and receipts stay on the host. This helper does not send messages,
fetch originals, delete images or change storage links. Existing cover and
ordering are verified after every batch. Stop and inspect private logs on errors.
"""

import argparse
import datetime
import pathlib,sys,json,os,re,sqlite3

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source_id',type=int,choices=[80,81,86,89,90,103])
parser.add_argument('--execute',action='store_true')
parser.add_argument('--max-uploads',type=int,default=3)
parser.add_argument('--audit-dir',type=pathlib.Path)
args=parser.parse_args()
assert 1<=args.max_uploads<=60,'upload limit must be 1-60'
home=pathlib.Path.home()
audit=args.audit_dir or home/'.openclaw/backups/yuexiaji-archive-recovery-20261002'
sys.path.insert(0,str(home/'.openclaw/workspace-nova/skills/social-image-downloader/scripts'))
import social_images as s
assert s.VERSION=='1.5.0','review the recovery tool before using a different downloader version'
manager_version=re.search(r'^VERSION\s*=\s*[\"\x27]([^\"\x27]+)',pathlib.Path(s.resolve_manager_script('nova',None)).read_text(),re.MULTILINE)
assert manager_version and manager_version[1]=='2.5.1','review the recovery tool before using a different manager version'
sid=args.source_id
database=s.default_state_dir()/'state/downloads.sqlite3'
read=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
read.row_factory=sqlite3.Row
source=read.execute('SELECT id,status,yuexiaji_id FROM sources WHERE id=?',(sid,)).fetchone()
assert source is not None,'source not found'
files=read.execute('SELECT id,imported_at FROM files WHERE source_id=? AND status="available"',(sid,)).fetchall()
if not args.execute:
 print(json.dumps({'sourceId':sid,'galleryId':source['yuexiaji_id'],'sourceStatus':source['status'],'files':len(files),'storedImportReceipts':sum(bool(f['imported_at']) for f in files),'dryRun':True}))
 read.close()
 raise SystemExit(0)
audit.mkdir(parents=True,exist_ok=True);os.chmod(audit,0o700)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup_path=audit/('source-'+str(sid)+'-'+stamp+'-before.sqlite3')
assert not backup_path.exists(),'backup name collision'
backup=sqlite3.connect(backup_path);os.chmod(backup_path,0o600)
read.backup(backup);backup.close();read.close()
store=s.Store(s.default_state_dir()); mgr=s.resolve_manager_script('nova',None)
source=store.conn.execute('SELECT * FROM sources WHERE id=?',(sid,)).fetchone()
job=store.conn.execute('SELECT job_id FROM job_sources WHERE source_id=? ORDER BY job_id LIMIT 1',(sid,)).fetchone()[0]
plan=s.yuexiaji_plan(store,job,sid)
assert plan['readyForImport'] and plan['tagReview']['pendingCount']==0
galleries=s.manager_run(mgr,'nova',['gallery','list'])['galleries']
matches=[g for g in galleries if g.get('sourceUrl')==source['canonical_url']]
if source['yuexiaji_id']:matches=[g for g in galleries if g.get('id')==source['yuexiaji_id']]
assert len(matches)<=1
before=None
if matches:
 before=s.manager_run(mgr,'nova',['gallery','get',str(matches[0]['id'])])['gallery']
snapshot=audit/('gallery-source-'+str(sid)+'-before.json')
if not snapshot.exists():
 snapshot.write_text(json.dumps(before,ensure_ascii=False,indent=2));os.chmod(snapshot,0o600)
existing_ids={before['id']} if before else set()
# Recover only exact upload-byte hashes already present. thumbnail v is the
# actual upload operation asset ID, not the gallery-image ID.
recovered=[]
if before:
 for u in plan['plans'][0]['uploads']:
  if u.get('alreadyImported'):continue
  images=[im for im in before['images'] if im.get('imageHash')==u['uploadSha256']]
  if not images:continue
  assert len(images)==1
  match=re.fullmatch(r'/api/media-assets\?v=([1-9][0-9]*)',images[0].get('thumbnail',''))
  assert match,'cannot recover a real upload asset id'
  asset=int(match.group(1))
  row=store.conn.execute('SELECT * FROM files WHERE id=?',(u['fileId'],)).fetchone()
  assert row['source_id']==sid and row['status']=='available' and not row['imported_at']
  now=s.utc_now()
  store.conn.execute('UPDATE files SET yuexiaji_asset_id=?,imported_at=? WHERE id=? AND imported_at IS NULL',(asset,now,u['fileId']))
  store.conn.commit()
  recovered.append({'fileId':u['fileId'],'assetId':asset,'imageHash':u['uploadSha256'],'proof':'exact gallery GET hash and thumbnail asset id'})
original_key=s.operation_key
def recovery_key(store,scope,scope_id,action,payload):
 if action=='gallery-upload' and payload.get('galleryId') in existing_ids:
  payload['isCover']=False
 return original_key(store,scope,scope_id,action,payload)
s.operation_key=recovery_key
original_run=s.manager_run
def preserve_cover(script,agent,args,key=None):
 if args[:2]==['gallery','upload'] and int(args[2]) in existing_ids:
  args=[arg for arg in args if arg!='--cover']
 return original_run(script,agent,args,key)
s.manager_run=preserve_cover
result=s.import_yuexiaji(store,job,'nova',None,False,sid,args.max_uploads)
record=audit/('import-source-'+str(sid)+'-'+str(len(list(audit.glob('import-source-'+str(sid)+'-*.json'))))+'.json')
record.write_text(json.dumps({'recoveredReceipts':recovered,'result':result},ensure_ascii=False,indent=2));os.chmod(record,0o600)
entry=result['results'][0]
if entry.get('galleryId'):
 after=original_run(mgr,'nova',['gallery','get',str(entry['galleryId'])])['gallery']
 if before:
  old={im['id']:im for im in before['images']};new={im['id']:im for im in after['images']}
  for image_id,im in old.items():
   assert image_id in new,'existing image deleted'
   assert all(new[image_id].get(k)==im.get(k) for k in ['imageHash','sortOrder','isCover','thumbnail']),'existing image altered'
  assert after.get('thumbnail')==before.get('thumbnail'),'existing cover altered'
  preserved=True
 else:preserved=None
else:after={};preserved=None
print(json.dumps({'sourceId':sid,'galleryId':entry.get('galleryId'),'created':entry.get('created'),'uploaded':entry.get('uploaded'),'recoveredReceipts':len(recovered),'complete':entry.get('complete'),'errorCount':len(entry.get('errors',[])),'imageCount':len(after.get('images',[])),'existingImagesPreserved':preserved},ensure_ascii=False),flush=True)
store.close()
if entry.get('errors'):
 raise SystemExit('Inspect the private result log before retrying; keep the recorded idempotency keys.')
