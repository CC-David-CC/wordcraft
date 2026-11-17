/** App-owned document choices. All account reads still use the shared service. */
export function canonicalPath(value, {root = false} = {}) {
  if (root && value === '') return value;
  if (typeof value !== 'string' || !value || value.length > 2048 || value.startsWith('/') || value.endsWith('/') ||
      value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[\0\\]/.test(p))) throw Error('A path relative to My files is required.');
  return value;
}

export function createDialogs({element, signal, check, onChange = () => {}}) {
  let active = null;
  function ask(title, build) {
    check(); if (active) return Promise.reject(Error('Finish the current WordCraft dialog first.'));
    const node = document.createElement('dialog'), heading = document.createElement('h2'), body = document.createElement('div'), actions = document.createElement('div');
    node.className = 'webos-wordcraft-close webos-wordcraft-dialog'; heading.textContent = title;
    heading.id = 'wordcraft-dialog-' + crypto.randomUUID(); node.setAttribute('aria-labelledby', heading.id); node.append(heading, body, actions); element.append(node);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); active = null; node.close(); node.remove(); onChange(); resolve(value); };
      const cancel = () => finish(null); active = node; onChange();
      const button = (label, value, action) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.addEventListener('click', () => action ? action() : finish(value)); actions.append(b); return b;
      };
      node.addEventListener('cancel', event => {event.preventDefault(); cancel();}); signal.addEventListener('abort', cancel, {once:true});
      build({node,body,button,finish,valid:()=>!settled&&!signal.aborted}); node.showModal();
      node.querySelector('input,button')?.focus();
    });
  }
  return Object.freeze({
    get active() { return active !== null; },
    path(initial) {
      return ask('Save As', ({node,body,button,finish}) => {
        node.dataset.kind = 'path'; const label = document.createElement('label'), input = document.createElement('input'), error = document.createElement('p');
        label.textContent = 'Account file path'; input.value = initial; input.required = true; input.setAttribute('aria-label','Account file path'); error.setAttribute('role','alert'); label.append(input); body.append(label,error);
        const save = () => { try {finish(canonicalPath(input.value));} catch(e) {error.textContent=e.message;} };
        input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();save();}});
        button('Save',null,save); button('Cancel',null);
      });
    },
    recover(path, needsCopy) {
      return ask('Recover unsaved WordCraft document?', ({node,body,button}) => {
        node.dataset.kind = 'recovery'; const message=document.createElement('p');
        message.textContent='A browser-local draft for '+(path||'an untitled document')+' is available. It is not a confirmed account save.'+
          (needsCopy?' The saved file changed or could not be verified; recovered work will require Save As.':'');
        body.append(message); button('Recover draft','recover'); button('Discard draft','discard'); button('Later',null);
      });
    },
    close() {
      return ask('Save changes before closing WordCraft?', ({node,body,button}) => {
        node.dataset.kind='close'; const message=document.createElement('p');message.textContent='This document has unsaved changes.';body.append(message);
        button('Save','save');button('Discard changes','discard');button('Cancel',null);
      });
    },
    open(files, directory='') {
      return ask('Open account document', ({node,body,button,finish,valid}) => {
        node.dataset.kind='open'; const breadcrumb=document.createElement('p'), up=document.createElement('button'), list=document.createElement('div'), status=document.createElement('p');
        up.type='button';up.textContent='Up';status.setAttribute('role','status');list.className='webos-wordcraft-file-list';body.append(breadcrumb,up,list,status);let generation=0, current='';
        async function load(path) {
          const version=++generation;try {
            canonicalPath(path,{root:true});check();status.textContent='Loading account files…';up.disabled=true;
            const result=await files.list(path);check();if(!valid()||version!==generation)return;
            current=path;breadcrumb.textContent='My files'+(path?' / '+path:'');up.disabled=!path;list.replaceChildren();
            for(const entry of result.entries){
              const target=canonicalPath((path?path+'/':'')+entry.name), b=document.createElement('button');b.type='button';b.textContent=entry.name;b.dataset.path=target;
              b.addEventListener('click',()=>entry.directory?void load(target):finish({kind:'account',path:target}));list.append(b);
            }
            status.textContent=result.entries.length?'Choose a document or folder.':'This folder is empty.';
          } catch(error) {if(valid()&&version===generation){status.textContent=error.message;up.disabled=!current;}}
        }
        up.addEventListener('click',()=>void load(current.includes('/')?current.slice(0,current.lastIndexOf('/')):''));
        const input=document.createElement('input');input.type='file';input.hidden=true;body.append(input);
        input.addEventListener('change',()=>{const file=input.files?.[0];if(!file)return;if(file.size>128*1024*1024){status.textContent='File exceeds 128 MiB.';return;}finish({kind:'import',file});});
        button('Import from this device',null,()=>{input.value='';if(typeof input.showPicker==='function')input.showPicker();else input.click();});button('Cancel',null);
        void load(directory);
      });
    }
  });
}
