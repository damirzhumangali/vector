(function(){
'use strict';
const V=window.Vektor,H=V.h;
const DEMO_STATE_KEY='vektor-demo-v3';
const OWNER_RECOVERY_KEY='vektor-owner-recovery-v1';
const OWNER_RECOVERY_TTL=15*60*1000;
let captureKind='before',returnFocus=null,pendingPasswordChange=null;
const field=(label,name,type='text',value='',required=true)=>`<label class="field"><span class="field-label">${H.esc(label)}</span><input class="input" name="${name}" type="${type}" value="${H.esc(value)}" ${required?'required':''}></label>`;
const area=(label,name,placeholder='',required=false)=>`<label class="field"><span class="field-label">${H.esc(label)}</span><textarea class="textarea" name="${name}" placeholder="${H.esc(placeholder)}" ${required?'required':''}></textarea></label>`;
const select=(label,name,options)=>`<label class="field"><span class="field-label">${H.esc(label)}</span><select class="select" name="${name}">${options.map(x=>`<option value="${H.esc(Array.isArray(x)?x[0]:x)}">${H.esc(Array.isArray(x)?x[1]:x)}</option>`).join('')}</select></label>`;
const footer=(label='Сохранить',danger=false)=>`<div class="modal-footer">${H.btn('Отмена','close-modal','secondary')}<button type="submit" class="btn btn-${danger?'danger':'primary'}">${label}</button></div>`;
function eventSaved(){if(V.state.offline)V.state.syncPending++;V.storeEvidence();V.save();}
function companyLink(companyCode){
 const url=new URL(location.pathname,location.origin);
 url.searchParams.set('company',companyCode);
 url.hash='login';
 return url.href;
}
function enteredCompany(value){
 const company=value.trim();
 if(!/^https?:\/\//i.test(company))return company;
 try{return new URL(company).searchParams.get('company')||'';}catch{return '';}
}
function randomCode(){
 return toHex(crypto.getRandomValues(new Uint8Array(16)));
}
function toHex(bytes){
 return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function passwordHash(password,salt){
 const encoder=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:120000,hash:'SHA-256'},key,256);
 return toHex(new Uint8Array(bits));
}
function formError(form,id,message){
 const alert=form.querySelector('#'+id)||document.getElementById(id);
 if(alert){alert.textContent=message;alert.hidden=!message;}
 else if(message)V.toast(message,'amber');
}
function loginError(form,message){formError(form,'login-error',message);}
function changePasswordError(form,message){formError(form,'change-password-error',message);}
function readLocal(key){
 try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}
}
function syncOwnerCredentials(){
 const s=V.state;
 const record=readLocal(OWNER_RECOVERY_KEY);
 if(!record?.rotated||record.companyCode!==s.companyCode||record.email!==s.ownerEmail)return false;
 if(record.credentialSalt===s.ownerPasswordSalt&&record.credentialHash===s.ownerPasswordHash)return false;
 s.ownerPasswordSalt=record.credentialSalt;
 s.ownerPasswordHash=record.credentialHash;
 s.signedInOwner=false;
 return true;
}
V.syncOwnerCredentials=syncOwnerCredentials;
function savedOwnerMatches(s){
 const saved=readLocal(DEMO_STATE_KEY);
 return Boolean(s.companyCode&&s.ownerEmail&&s.ownerPasswordSalt&&s.ownerPasswordHash
   &&saved?.companyCode===s.companyCode&&saved.ownerEmail===s.ownerEmail);
}
function ownerResetRecord(){
 const s=V.state;
 const token=new URLSearchParams(location.search).get('owner-reset');
 const record=readLocal(OWNER_RECOVERY_KEY);
 if(!token||!record||record.token!==token||!(record.expiresAt>Date.now())||!savedOwnerMatches(s))return null;
 if(record.companyCode!==s.companyCode||record.email!==s.ownerEmail)return null;
 if(record.credentialSalt!==s.ownerPasswordSalt||record.credentialHash!==s.ownerPasswordHash)return null;
 return record;
}
V.ownerResetTokenValid=()=>Boolean(ownerResetRecord());
function withRecoveryLock(work){
 const locks=window.navigator?.locks;
 return locks?locks.request(OWNER_RECOVERY_KEY,work):work();
}
function createOwnerRecoveryLink(form,f,s){
 return withRecoveryLock(()=>{
   if(!form.isConnected||V.state!==s)return;
   syncOwnerCredentials();
   formError(form,'owner-recovery-error','');
   if(!savedOwnerMatches(s)||f.email.trim().toLowerCase()!==s.ownerEmail){
     return formError(form,'owner-recovery-error','Введите рабочую почту владельца, указанную при регистрации в этом браузере.');
   }
   const previous=readLocal(OWNER_RECOVERY_KEY);
   const token=randomCode();
   const record={
     companyCode:s.companyCode,email:s.ownerEmail,
     credentialSalt:s.ownerPasswordSalt,credentialHash:s.ownerPasswordHash,
     rotated:previous?.companyCode===s.companyCode&&previous.rotated===true,
     token,expiresAt:Date.now()+OWNER_RECOVERY_TTL
   };
   localStorage.setItem(OWNER_RECOVERY_KEY,JSON.stringify(record));
   const url=new URL(location.pathname,location.origin);
   url.searchParams.set('owner-reset',token);
   url.hash='owner-reset';
   V.showModal('Ссылка для восстановления',`<div class="stack"><p class="modal-description">В макете ссылка появляется в этом окне. Откройте её в этом профиле браузера в течение 15 минут.</p><a class="btn btn-primary" href="${H.esc(url.href)}">Задать новый пароль</a><p class="muted">В рабочей системе ссылка придёт на рабочую почту владельца.</p></div><div class="modal-footer">${H.btn('Закрыть','close-modal','secondary')}</div>`);
 });
}
async function resetOwnerPassword(form,f,s){
 const error=message=>formError(form,'owner-reset-error',message);
 const invalid='Ссылка истекла или уже использована. Запросите новую ссылку.';
 error('');
 syncOwnerCredentials();
 const record=ownerResetRecord();
 if(!record)return error(invalid);
 if(f.password.length<6)return error('Введите пароль длиной от 6 символов.');
 if(f.password!==f.confirmation)return error('Пароли не совпадают.');
 const candidate=await passwordHash(f.password,record.credentialSalt);
 if(candidate===record.credentialHash)return error('Выберите пароль, который отличается от прежнего.');
 const salt=randomCode();
 const hash=await passwordHash(f.password,salt);
 return withRecoveryLock(()=>{
   if(!form.isConnected||V.state!==s)return;
   syncOwnerCredentials();
   if(ownerResetRecord()?.token!==record.token)return error(invalid);
   localStorage.setItem(OWNER_RECOVERY_KEY,JSON.stringify({
     companyCode:record.companyCode,email:record.email,
     credentialSalt:salt,credentialHash:hash,rotated:true
   }));
   syncOwnerCredentials();
   s.signedInEmployeeId=null;
   V.ownerLoginEmployeeId=null;
   pendingPasswordChange=null;
   history.replaceState(null,'',companyLink(s.companyCode));
   V.navigate('login','employee');
   V.toast('Пароль владельца обновлён. Войдите с новым паролем.');
 });
}
function inviteField(companyCode){
 return `<label class="field"><span class="field-label">Ссылка для входа</span><input class="input" type="url" data-company-link value="${H.esc(companyLink(companyCode))}" readonly></label>`;
}
function employeePasswordHandoff(employee,password){
 return V.showModal('Данные для входа сотрудника',`<div class="stack"><p class="modal-description">Передайте сотруднику ссылку, логин и временный пароль. После входа сотрудник задаст свой пароль.</p>${inviteField(employee.companyCode)}<dl class="detail-list"><div><dt>Логин</dt><dd>${H.esc(employee.login)}</dd></div><div><dt>Временный пароль</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${H.esc(password)}</dd></div></dl></div><div class="modal-footer">${H.btn('Скопировать ссылку','copy-company-link','secondary','copy')}${H.btn('Готово','close-modal','primary')}</div>`);
}
function pendingEmployee(){
 const pending=pendingPasswordChange;
 if(!pending||pending.state!==V.state)return null;
 if(pending.companyCode!=='astana-service'&&pending.companyCode!==V.state.companyCode)return null;
 return V.state.employees.find(employee=>employee.id===pending.id&&employee.passwordHash===pending.hash&&employee.passwordSalt===pending.salt&&employee.mustChangePassword!==false);
}
V.hasPendingPasswordChange=()=>Boolean(pendingEmployee());
function finishEmployeeSignIn(s,employee){
 s.signedInOwner=false;
 s.signedInEmployeeId=employee.id;
 employee.lastLoginAt=new Date().toISOString();
 V.navigate('pin','employee');
}
function rememberQuickAccess(method){
 const s=V.state;
 const employee=s.employees.find(e=>e.id===s.signedInEmployeeId);
 if(employee)employee.quickAccess=method;
}
async function submitAccessForm(form,work,onError){
 const button=form.querySelector('button[type="submit"]');
 if(button.disabled)return;
 button.disabled=true;
 try{await work();}
 catch{if(form.isConnected)onError('Доступные данные для входа можно сохранить и проверить на локальном адресе или через HTTPS.');}
 finally{button.disabled=false;}
}
async function login(form,f,s){
 pendingPasswordChange=null;
 syncOwnerCredentials();
 loginError(form,'');
 const companyCode=enteredCompany(f.company);
 const loginName=f.login.trim().toLowerCase();
 const employee=(companyCode===s.companyCode||companyCode==='astana-service')
   ?s.employees.find(e=>e.companyCode===companyCode&&e.login===loginName)
   :null;
 const owner=companyCode===s.companyCode&&loginName===s.ownerEmail;
 const resetEmployeeId=V.ownerLoginEmployeeId;
 if(resetEmployeeId&&!owner)return loginError(form,'Войдите с рабочей почтой и паролем владельца компании.');
 const salt=owner?s.ownerPasswordSalt:employee?.passwordSalt;
 const hash=owner?s.ownerPasswordHash:employee?.passwordHash;
 if(salt&&hash){
   const actual=await passwordHash(f.password,salt);
   if(!form.isConnected||V.state!==s)return;
   syncOwnerCredentials();
   const unchanged=owner
     ?s.companyCode===companyCode&&s.ownerPasswordSalt===salt&&s.ownerPasswordHash===hash
     :(companyCode==='astana-service'||s.companyCode===companyCode)&&s.employees.includes(employee)&&employee.passwordSalt===salt&&employee.passwordHash===hash;
   if(actual!==hash||!unchanged)return loginError(form,'Проверьте код компании, логин и пароль.');
   if(owner){
     s.signedInOwner=true;
     s.signedInEmployeeId=null;
     const resetEmployee=s.employees.find(e=>e.id===resetEmployeeId&&e.companyCode===companyCode&&e.login);
     if(resetEmployee)s.selectedEmployee=resetEmployee.id;
     V.navigate(resetEmployee?'employee':'team','dispatcher');
   }else if(employee.mustChangePassword!==false){
     s.signedInOwner=false;
     s.signedInEmployeeId=null;
     pendingPasswordChange={state:s,id:employee.id,companyCode,salt,hash};
     V.navigate('change-password','employee');
     return;
   }else{
     finishEmployeeSignIn(s,employee);
   }
   V.toast('Вход выполнен');
   return;
 }
 if(companyCode==='astana-service'&&loginName==='a.sadykov'){
   s.signedInOwner=false;
   s.signedInEmployeeId=null;
   V.navigate('pin','employee');
   V.toast('Демонстрационный вход выполнен');
   return;
 }
 loginError(form,'Проверьте код компании, логин и пароль. Приглашение доступно в профиле браузера, где создана компания.');
}
async function changePassword(form,f,s){
 const employee=pendingEmployee();
 if(!employee)return V.navigate('login');
 changePasswordError(form,'');
 if(f.password.length<6)return changePasswordError(form,'Введите пароль длиной от 6 символов.');
 if(f.password!==f.confirmation)return changePasswordError(form,'Пароли не совпадают.');
 const pending=pendingPasswordChange;
 const candidate=await passwordHash(f.password,pending.salt);
 if(!form.isConnected||pendingPasswordChange!==pending||pendingEmployee()!==employee)return;
 if(candidate===pending.hash)return changePasswordError(form,'Выберите пароль, который отличается от временного.');
 const salt=randomCode();
 const hash=await passwordHash(f.password,salt);
 if(!form.isConnected||pendingPasswordChange!==pending||pendingEmployee()!==employee)return;
 employee.passwordSalt=salt;
 employee.passwordHash=hash;
 employee.mustChangePassword=false;
 pendingPasswordChange=null;
 finishEmployeeSignIn(s,employee);
 V.toast('Пароль обновлён');
}
async function resetEmployeePassword(s){
 syncOwnerCredentials();
 const companyCode=s.companyCode||'astana-service';
 const employee=s.employees.find(e=>e.id===s.selectedEmployee&&e.companyCode===companyCode&&e.login);
 const canReset=()=>s.role==='dispatcher'&&(!s.companyCode||s.signedInOwner);
 if(!canReset()||!employee)return V.toast('Войдите как владелец компании, чтобы сбросить пароль сотрудника.','amber');
 const previousHash=employee.passwordHash;
 try{
   const temporaryPassword=randomCode().slice(0,16);
   const salt=randomCode();
   const hash=await passwordHash(temporaryPassword,salt);
   syncOwnerCredentials();
   if(V.state!==s||!canReset()||companyCode!==(s.companyCode||'astana-service')||s.selectedEmployee!==employee.id||!s.employees.includes(employee)||employee.passwordHash!==previousHash)return;
   employee.passwordSalt=salt;
   employee.passwordHash=hash;
   employee.mustChangePassword=true;
   delete employee.quickAccess;
   if(s.signedInEmployeeId===employee.id)s.signedInEmployeeId=null;
   if(pendingPasswordChange?.id===employee.id)pendingPasswordChange=null;
   V.render(true);
   return employeePasswordHandoff(employee,temporaryPassword);
 }catch{
   return V.toast('Выполните сброс на локальном адресе или через HTTPS.','amber');
 }
}
async function register(form,f,s){
 const companyName=f.company.trim();
 const ownerName=[f.name.trim(),f.surname.trim()].filter(Boolean).join(' ');
 if(!companyName||!ownerName){
   V.toast('Укажите название компании и имя владельца','amber');
   form.elements[companyName?'name':'company'].focus();
   return;
 }
 const salt=randomCode();
 const hash=await passwordHash(f.password,salt);
 if(!form.isConnected||V.state!==s)return;
 s.companyCode=randomCode();
 s.companyName=companyName;
 s.ownerName=ownerName;
 s.ownerEmail=f.email.trim().toLowerCase();
 s.ownerPasswordSalt=salt;
 s.ownerPasswordHash=hash;
 s.signedInOwner=true;
 s.signedInEmployeeId=null;
 V.navigate('team','dispatcher');
 V.toast('Открыт демо-кабинет компании «'+companyName+'»');
}
async function addEmployee(form,f,s){
 const name=f.name.trim();
 const loginName=f.login.trim().toLowerCase();
 if(!name||!loginName){
   V.toast('Укажите имя и логин сотрудника','amber');
   form.elements[name?'login':'name'].focus();
   return;
 }
 const companyCode=s.companyCode||'astana-service';
 const loginTaken=()=>s.employees.some(e=>e.companyCode===companyCode&&e.login===loginName)||loginName===s.ownerEmail||(companyCode==='astana-service'&&loginName==='a.sadykov');
 if(loginTaken()){
   V.toast('Выберите другой логин. Этот уже занят.','amber');
   form.elements.login.focus();
   return;
 }
 const salt=randomCode();
 const hash=await passwordHash(f.password,salt);
 if(!form.isConnected||V.state!==s||companyCode!==(s.companyCode||'astana-service'))return;
 if(loginTaken())return V.toast('Выберите другой логин. Этот уже занят.','amber');
 const employee={
   id:'e'+randomCode(),name,initials:name.split(/\s+/).map(part=>part[0]).slice(0,2).join(''),
   role:f.role,status:'available',tasks:0,load:0,color:'green',
   companyCode,login:loginName,passwordSalt:salt,passwordHash:hash,mustChangePassword:true
 };
 s.employees.push(employee);
 V.navigate('team');
 employeePasswordHandoff(employee,f.password);
}
function modal(name){
 const s=V.state,t=V.current();returnFocus=document.activeElement;
 if(name==='late')return V.showModal('Сообщить о задержке',`<p class="modal-description">Диспетчер увидит причину и ожидаемое время. Установленный срок задачи сохранится.</p><form id="late-form">${select('Причина задержки','reason',['Дорожная ситуация','Задержка на предыдущем объекте','Проблема с транспортом','Другая причина'])}${field('Планирую прибыть','arrival','time','13:30')}${area('Комментарий','comment','Дополнительные сведения, если нужны')}${s.offline?'<div class="info-box amber">Сообщение будет доставлено после появления связи.</div>':''}${footer('Сообщить диспетчеру')}</form>`);
 if(name==='urgent')return V.showModal('Срочный уход',`<p class="modal-description">Текущая работа будет приостановлена. Не начатые задания вернутся диспетчеру для переназначения.</p><form id="urgent-form">${select('Причина','reason',['Личные обстоятельства','Самочувствие','Транспорт','Другая причина'])}<label class="field"><span class="field-label">Объект оставлен безопасно?</span><select class="select" name="safe"><option value="yes">Да, работы безопасно приостановлены</option><option value="no">Нет, требуется срочное вмешательство</option></select></label>${s.offline?'<div class="info-box amber">Нет связи. Уведомление останется на устройстве. Для срочной ситуации свяжитесь с диспетчером доступным способом.</div>':''}${footer('Подтвердить уход',true)}</form>`);
 if(name==='pause')return V.showModal(t.status==='paused'?'Продолжить работу':'Приостановить работу',t.status==='paused'?`<p class="modal-description">Заявка №${H.esc(t.id)} приостановлена. Фото и заполненные пункты сохранены.</p><div class="info-box">После возвращения на объект подтвердите возможность продолжить работу.</div><div class="modal-footer">${H.btn('Закрыть','close-modal','secondary')}${H.btn('Продолжить работу','resume-task','primary','play')}</div>`:`<form id="pause-form">${select('Причина паузы','reason',['Нет доступа на объект','Нужны материалы или инструмент','Ожидаю согласования','Безопасная остановка работ','Другая причина'])}${area('Что уже сделано','comment','Кратко опишите состояние работы')}${footer('Приостановить')}</form>`);
 if(name==='assignment'||name==='handover')return V.showModal(name==='assignment'?'Назначить исполнителя':'Передать работу',`<p class="modal-description">Заявка №${H.esc(t.id)} · ${H.esc(t.object)}. Сделанные фотографии и пункты останутся в истории.</p><form id="assignment-form">${select('Новый исполнитель','employee',s.employees.filter(e=>e.name!==t.employee).map(e=>e.name))}${area('Комментарий для коллеги','comment','Что выполнено, что осталось, на что обратить внимание',true)}${footer(name==='assignment'?'Назначить':'Передать задачу')}</form>`);
 if(name==='emergency')return V.showModal('Аварийный выезд',`<div class="info-box red" style="margin-bottom:20px">${H.icon('zap',20)}<div><strong>Протечка в техническом помещении</strong><p>ЖК «Зелёный квартал» · требуется специалист</p></div></div><p class="modal-description">При принятии текущая работа будет поставлена на паузу. Убедитесь, что объект можно безопасно оставить.</p><form id="emergency-form"><label class="check-row"><input type="checkbox" name="safe" required><span>Текущую работу можно безопасно приостановить</span></label><div class="modal-footer">${H.btn('Не могу принять','decline-emergency','secondary')}<button type="submit" class="btn btn-primary">Принять аварию</button></div></form>`);
 if(name==='decline-emergency')return V.showModal('Причина отказа',`<form id="decline-emergency-form">${select('Почему не можете принять','reason',['Текущую работу нельзя прервать','Нет необходимого допуска','Необходим другой инструмент','Другая причина'])}${area('Комментарий','comment','Дополнительные сведения')}${footer('Передать диспетчеру')}</form>`);
 if(name==='shift-end')return V.showModal('Завершение смены',`<p class="modal-description">Есть незавершённые назначения. Выберите, что сделать с текущей работой.</p><form id="shift-end-form"><label class="modal-radio"><input type="radio" name="decision" value="pause" checked><span><strong>Приостановить до следующей смены</strong><small>Текущее состояние и фотографии сохранятся</small></span></label><label class="modal-radio"><input type="radio" name="decision" value="handover"><span><strong>Передать другому сотруднику</strong><small>Откроется выбор исполнителя</small></span></label><label class="modal-radio"><input type="radio" name="decision" value="extend"><span><strong>Продолжить работу</strong><small>Продление смены будет зафиксировано отдельно</small></span></label>${footer('Подтвердить')}</form>`);
 if(name==='reject')return V.showModal('Вернуть на доработку',`<p class="modal-description">Выберите, что требуется исправить. Причина останется в истории и появится у сотрудника.</p><form id="reject-form">${select('Причина','reason',[['result','Работа выполнена не полностью'],['photo','Нужен дополнительный снимок результата'],['comment','Нужно пояснение в отчёте']])}${area('Что нужно исправить','comment','Например, подтвердить фото подключение после ремонта',true)}<div class="info-box amber">Если исходное состояние уже изменено, фото «до» нельзя восстановить пересъёмкой. Зафиксируйте недостаток доказательств.</div>${footer('Вернуть сотруднику')}</form>`);
 if(name==='contact')return V.showModal('Контакты по заданию',`<div class="list-row"><span class="avatar">МК</span><div class="grow"><strong>Марат Касенов</strong><p>Ответственный на объекте</p></div>${H.badge('На месте','green')}</div><div class="list-row"><span class="avatar blue">АН</span><div class="grow"><strong>Алия Нурланова</strong><p>Диспетчер технической службы</p></div></div><div class="info-box" style="margin-top:20px">Контактные карточки показаны на демонстрационных данных. Реальный звонок из макета не выполняется.</div><div class="modal-footer">${H.btn('Понятно','close-modal','primary')}</div>`);
 if(name==='edit-profile')return V.showModal('Данные профиля',`<form id="profile-form">${field('Отображаемое имя','name','text',s.profileName||'Арман Садыков')}${field('Рабочая почта','email','email',s.profileEmail||'arman@example.com')}${select('Язык приложения','language',['Русский','Қазақша'])}<div class="info-box">В макете сохраняются отображаемые данные. Язык интерфейса — русский.</div>${footer()}</form>`);
 if(name==='problem')return V.showModal('Сообщить о проблеме',`<form id="problem-form">${select('Что произошло','reason',['Выявлена неисправность','Нет доступа','Не хватает материалов','Есть риск для безопасности'])}${area('Опишите проблему','comment','Что обнаружено и какое решение нужно',true)}${footer('Зафиксировать проблему')}</form>`);
 if(name==='manual-arrival')return V.showModal('Отметка без геолокации',`<p class="modal-description">Прибытие будет отмечено с причиной и передано руководителю для проверки.</p><form id="manual-arrival-form">${select('Почему координаты недоступны','reason',['Работа в подвале или внутри здания','Недостаточная точность','Ошибка точки объекта','Другая причина'])}${area('Комментарий','comment','Укажите вход или помещение, где находитесь',true)}${footer('Я на объекте')}</form>`);
 if(name==='capture')return V.showModal(captureKind==='before'?'Фото до начала работ':'Фото результата',`<p class="modal-description">Режим камеры в макете. Кнопка добавляет демонстрационный снимок.</p><div class="camera-view">${H.photo(captureKind)}<div class="camera-crosshair"></div><div class="camera-bottom">${H.icon('zap',20)}<button class="shutter" data-action="capture-demo" aria-label="Снять демонстрационный кадр">${H.icon('camera',25)}</button>${H.icon('refresh',20)}</div></div><div class="info-box green" style="margin-top:16px">${H.icon('check-circle',17)}Освещение и резкость · пример успешной проверки</div>`);
 if(name==='photo')return V.showModal(captureKind==='before'?'Снимок до работы':'Снимок после работы',`${H.photo(captureKind)}<div class="list-row"><span class="muted">Источник</span><strong>Демонстрационный снимок</strong></div><div class="list-row"><span class="muted">Автор</span><strong>Арман Садыков</strong></div><div class="list-row"><span class="muted">Заявка</span><strong>№${H.esc(t.id)}</strong></div><div class="modal-footer">${H.btn('Закрыть','close-modal','primary')}</div>`,true);
 if(name==='employee')return V.showModal('Добавить сотрудника',`<form id="employee-form" class="stack">${field('Имя и фамилия','name')}${select('Специализация','role',['Инженер по обслуживанию','Электромонтажник','Сантехник','Специалист СКУД','Техник инженерных систем'])}<label class="field"><span class="field-label">Логин сотрудника</span><input class="input" name="login" placeholder="Например, a.sadykov" aria-describedby="employee-login-help" autocomplete="off" autocapitalize="none" required><span class="field-hint" id="employee-login-help">Придумайте уникальный логин и передайте его сотруднику. Можно использовать и его почту.</span></label><label class="field"><span class="field-label">Временный пароль</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="6" required><span class="field-hint">От 6 символов. Используйте тестовый пароль.</span></label><div class="info-box">После добавления появятся ссылка и данные для входа в этом профиле браузера.</div>${footer('Добавить в команду')}</form>`);
 if(name==='object')return V.showModal('Добавить объект',`<form id="object-form">${field('Название объекта','name')}${field('Адрес','address')}${select('Тип объекта','type',['Бизнес-центр','Жилой комплекс','Образование','Общественный объект'])}${field('Ответственный на объекте','contact')}${footer('Сохранить объект')}</form>`);
 if(name==='plan')return V.showModal('Повторяющаяся работа',`<form id="plan-form">${field('Название работы','title','text','Осмотр инженерных систем')}${select('Объект','object',s.objects.map(o=>o.name))}${select('Повторение','repeat',['Каждый рабочий день','Каждый вторник','Каждый месяц'])}${field('Время выполнения','time','time','09:00')}${select('Если выпадает на выходной','holiday',['Перенести на следующий рабочий день','Выполнить по расписанию','Пропустить повторение'])}${footer('Создать план')}</form>`);
 if(name==='holiday')return V.showModal('Выходной компании',`<form id="holiday-form">${field('Название','name','text','Внутренний выходной')}${field('Дата','date','date','2026-11-13')}${select('Плановые задачи','policy',['По правилам каждого шаблона','Перенести на следующий рабочий день','Выполнить по расписанию'])}${footer('Добавить в календарь')}</form>`);
 if(name==='filters')return V.showModal('Фильтры заявок',`<form id="filters-form">${select('Статус','status',[['all','Все заявки'],['active','В работе'],['review','На проверке'],['done','Завершённые'],['urgent','Аварийные']])}${field('Поиск по названию или объекту','search','text',s.orderSearch,false)}${footer('Показать заявки')}</form>`);
 if(name==='settings')return V.showModal('Настройки устройства',`<div class="switch-row"><div><strong>Уведомления</strong><p>Назначения и изменения по работе</p></div><button class="switch ${s.settings.notifications?'active':''}" data-action="toggle-notifications" aria-label="Уведомления"></button></div><div class="list-row"><span class="grow">Быстрый вход</span>${H.nav('Настроить PIN','pin','secondary','lock')}</div><div class="list-row"><span class="grow">Демонстрационный вход</span>${H.nav('Экран входа','login','secondary','logout')}</div><div class="modal-footer">${H.btn('Готово','close-modal','primary')}</div>`);
 if(name==='biometric')return V.showModal('Вход по биометрии',`<div class="empty-state">${H.icon('fingerprint',65)}<h3>Быстро и удобно</h3><p>В приложении здесь появится системный запрос Face ID или отпечатка. В макете можно посмотреть успешный вход.</p></div><div class="modal-footer">${H.btn('Продолжить в макете','biometric-success','primary')}</div>`);
 if(name==='forgot-password')return V.showModal('Восстановление доступа',`<div class="stack"><p class="modal-description">Сотруднику новый временный пароль выдаёт владелец компании. Владелец открывает «Команда» → карточка сотрудника → «Сбросить пароль».</p><p class="muted">Владелец компании может восстановить доступ по рабочей почте, указанной при регистрации.</p></div><div class="modal-footer">${H.btn('Вернуться ко входу','close-modal','secondary')}${H.nav('Я владелец','owner-recovery','primary')}</div>`);
 if(name==='export')return V.showModal('Выгрузить отчёт',`<p class="modal-description">Выберите формат демонстрационного отчёта по текущим заявкам.</p><div class="stack">${H.btn('Таблица для Excel · CSV','export-csv','secondary','file-spreadsheet')}${H.btn('Сохранить страницу в PDF','export-pdf','secondary','file-text')}</div>`);
 if(name==='invitation')return V.showModal('Ссылка компании',`<div class="stack"><p class="modal-description">Сотрудник открывает ссылку и вводит свой логин и пароль. Данные для входа сохраняются в этом профиле браузера.</p><strong>${H.esc(s.companyName)}</strong>${inviteField(s.companyCode||'astana-service')}</div><div class="modal-footer">${H.btn('Скопировать ссылку','copy-company-link','secondary','copy')}${H.btn('Добавить сотрудника','open-employee','primary','user')}</div>`);
 if(name==='menu')return V.showModal('Рабочее пространство',`<div class="menu-drawer"><div class="nav-label">${V.ROLELABEL[s.role]}</div><nav class="nav-list">${V.NAV[s.role].map(V.navItem).join('')}${V.navItem('screens')}</nav><div class="divider"></div>${H.nav('Вход в компанию','login','ghost','logout')}</div>`);
 if(name==='reset')return V.showModal('Начать просмотр заново?',`<p class="modal-description">Демонстрационные задачи и формы вернутся в исходное состояние.</p><div class="modal-footer">${H.btn('Продолжить просмотр','close-modal','secondary')}${H.btn('Сбросить макет','confirm-reset','primary','refresh')}</div>`);
}
function saveCsv(name,rows){let data='\ufeff'+rows.map(row=>row.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(';')).join('\r\n');const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function action(name,el){
 if(el?.dataset.taskTarget)V.selectTask(el.dataset.taskTarget,null);
 const s=V.state,t=V.current();
 const dialogs={'open-late':'late','open-urgent':'urgent','open-pause':'pause','open-handover':'handover','open-assignment':'assignment','open-emergency':'emergency','decline-emergency':'decline-emergency','open-reject':'reject','open-employee':'employee','open-object':'object','open-plan':'plan','add-holiday':'holiday','open-filters':'filters','open-settings':'settings','use-biometric':'biometric','open-menu':'menu','reset-demo':'reset','export-report':'export','export-orders':'export','send-invitation':'invitation','shift-end':'shift-end','forgot-password':'forgot-password'};
 if(dialogs[name]){if(['open-pause','open-assignment','open-handover'].includes(name)&&['done','review'].includes(t.status))return V.toast('Отчёт уже передан. Выберите незавершённую работу.','amber');return modal(dialogs[name]);}
 if(name==='close-modal'){V.closeModal();returnFocus?.focus?.();return;}
 if(name==='confirm-reset'){V.closeModal();V.reset();return V.toast('Макет возвращён в исходное состояние');}
 if(name==='cancel-password-change'){pendingPasswordChange=null;return V.navigate('login');}
 if(name==='owner-login-for-reset'){
   const employee=s.employees.find(e=>e.id===s.selectedEmployee&&e.companyCode===s.companyCode&&e.login);
   if(!employee)return;
   V.ownerLoginEmployeeId=employee.id;
   return V.navigate('login');
 }
 if(name==='reset-employee-password')return resetEmployeePassword(s);
 if(name==='copy-company-link'){
   const input=document.querySelector('[data-company-link]');
   if(!input)return;
   input.focus();
   input.select();
   if(!navigator.clipboard)return V.toast('Ссылка выделена для копирования');
   navigator.clipboard.writeText(input.value).then(()=>V.toast('Ссылка скопирована'),()=>V.toast('Ссылка выделена для копирования'));
   return;
 }
 if(name==='demo-login'||name==='biometric-success'){if(name==='demo-login'){pendingPasswordChange=null;s.signedInOwner=false;s.signedInEmployeeId=null;}else rememberQuickAccess('biometric');V.navigate(name==='demo-login'?'pin':'tasks','employee');return V.toast('Открыто демонстрационное рабочее пространство');}
 if(name==='capture-before'||name==='capture-after'){if(['review','done'].includes(t.status))return V.toast('Переданный отчёт доступен для просмотра','amber');captureKind=name.endsWith('before')?'before':'after';if(t.status==='assigned'||t.status==='accepted'||t.status==='travel')return V.toast('Сначала подтвердите прибытие на объект','amber');return modal('capture');}
 if(name==='open-photo'){captureKind=el?.dataset.photoKind||s.photoTab;return modal('photo');}
 if(name==='capture-demo'){s.photos[captureKind]++;eventSaved();V.closeModal();s.photoTab=captureKind;V.render(true);return V.toast((captureKind==='before'?'Фото «до»':'Фото «после»')+' добавлено'+(s.offline?' · ожидает отправки':''));}
 if(name==='accept-task'){t.status='accepted';eventSaved();V.render(true);return V.toast('Назначение принято. Можно выехать на объект.');}
 if(name==='start-travel'){t.status='travel';eventSaved();V.navigate('route');return V.toast('Начало поездки зафиксировано');}
 if(name==='arrive'){if(t.status!=='travel')return V.toast(['arrived','work','paused','review','done'].includes(t.status)?'Прибытие уже зафиксировано':'Сначала примите задание и начните поездку','amber');t.status='arrived';eventSaved();V.navigate('task');return V.toast('Прибытие отмечено · демо-геопозиция в радиусе 100 м');}
 if(name==='start-work'){if(!s.photos.before){s.photoTab='before';V.navigate('photos');return V.toast('Добавьте фото «до», чтобы начать работу','amber');}t.status='work';eventSaved();V.navigate('checklist');return V.toast('Работа начата');}
 if(name==='resume-task'){if(t.status!=='paused')return V.toast('Эта работа не приостановлена','amber');t.status='work';eventSaved();V.closeModal();V.render(true);return V.toast('Работа возобновлена');}
 if(name==='finish-task'){if(['review','done'].includes(t.status))return V.toast('Этот отчёт уже передан на проверку');if(!s.checks.every(Boolean)||!s.photos.before||!s.photos.after)return V.toast('Заполните чек-лист и добавьте фото до и после','amber');t.status='review';if(t.reworkReason){t.lastReworkReason=t.reworkReason;delete t.reworkReason;t.tag='Доработка выполнена';}eventSaved();V.navigate('tasks');return V.toast(s.offline?'Работа завершена. Отчёт ожидает отправки.':'Работа завершена. Отчёт передан руководителю.');}
 if(name==='approve-report'){if(t.status!=='review')return V.toast('Выберите отчёт из очереди приёмки','amber');t.status='done';delete t.reworkReason;if(t.tag==='Требует доработки')t.tag='Доработка принята';s.reviewed=true;V.save();V.navigate('review');return V.toast('Работа принята. Решение сохранено в истории.');}
 if(name==='toggle-offline'){s.offline=!s.offline;V.render(true);return V.toast(s.offline?'Включён просмотр работы без сети':'Связь восстановлена. Можно синхронизировать данные.');}
 if(name==='sync-now'){if(s.offline)return V.toast('Восстановите связь для синхронизации','amber');const n=s.syncPending;s.syncPending=0;V.render(true);return V.toast(n?`Передано ${n} событий. Данные синхронизированы.`:'Все данные уже синхронизированы');}
 if(name==='prepare-offline'){if(s.offline)return V.toast('Для обновления заданий нужна связь','amber');s.prepared=true;V.render(true);return V.toast('Задания, инструкции и чек-листы подготовлены');}
 if(name==='shift-start'||name==='resume-shift'){s.shiftActive=true;s.shiftPaused=false;const e=s.employees.find(e=>e.id==='e1');e.status='available';eventSaved();V.render(true);return V.toast(name==='shift-start'?'Смена начата':'Вы снова доступны для назначений');}
 if(name==='clear-notifications'){s.notificationsRead=true;V.render(true);return V.toast('Все уведомления отмечены прочитанными');}
 if(name==='toggle-queue'){s.queueEnabled=!s.queueEnabled;V.render(true);return V.toast(s.queueEnabled?'Автоназначение включено':'Новые автоматические назначения приостановлены');}
 if(name==='toggle-planning-view'){s.planningView=s.planningView==='month'?'week':'month';return V.render(true);}
 if(name==='toggle-analytics'){s.analyticsRange=s.analyticsRange==='week'?'month':'week';return V.render(true);}
 if(name==='reset-order-search'){s.orderFilter='all';s.orderSearch='';return V.render();}
 if(name==='preview-import'){s.importStage='preview';V.navigate('import');return;}
 if(name==='confirm-import'){if(s.importStage==='done')return V.toast('Этот образец уже импортирован');for(let i=0;i<5;i++){const id='I'+(1101+i);if(!s.tasks.some(t=>t.id===id))s.tasks.push({id,title:['Проверка вентиляции','Обслуживание освещения','Осмотр инженерных систем','Проверка пожарных выходов','Диагностика насосной станции'][i],object:s.objects[i%4].name,address:s.objects[i%4].address,status:'assigned',priority:'normal',time:'09:00–10:00',due:'10:00',employee:s.employees[i%5].name,tag:'Импорт · плановая',estimate:'1 час'});}s.importStage='done';V.render();return V.toast('Добавлено 5 заданий из демонстрационного образца');}
 if(name==='download-template'){saveCsv('vektor-template.csv',[['Объект','Вид работ','Исполнитель','Дата','Время','Срок','Приоритет'],['БЦ «Астана Тауэр»','Осмотр инженерных систем','Арман Садыков','2026-11-03','09:00','10:00','Обычный']]);return V.toast('Шаблон CSV для Excel подготовлен');}
 if(name==='export-csv'){saveCsv('vektor-report.csv',[['Заявка','Работа','Объект','Исполнитель','Статус','Срок'],...s.tasks.map(t=>[t.id,t.title,t.object,t.employee,V.STATUS[t.status]?.[0]||t.status,t.due])]);V.closeModal();return V.toast('Таблица с текущими заявками выгружена');}
 if(name==='export-pdf'){V.closeModal();return window.print();}
 if(name==='resolve-conflict'){const choice=document.querySelector('input[name="conflict-resolution"]:checked');if(!choice)return V.toast('Выберите решение по конфликту','amber');s.conflictResolved=true;s.conflictDecision=choice.value;V.render();return V.toast('Решение сохранено. Исходные события оставлены в истории.');}
 if(name==='toggle-notifications'){s.settings.notifications=!s.settings.notifications;V.save();return modal('settings');}
 console.warn('Unhandled demo action',name);V.toast('Откройте соответствующий экран в каталоге макета','amber');
}
document.addEventListener('click',e=>{
 if(e.target.matches('[data-dismiss]')){V.closeModal();return;}
 const el=e.target.closest('[data-action],[data-page],[data-role],[data-view],[data-task],[data-review-task],[data-employee],[data-object],[data-filter],[data-order-filter],[data-review-filter],[data-photo-tab],[data-task-tab],[data-day],[data-planning-day],[data-modal]');if(!el||el.disabled)return;
 const s=V.state,d=el.dataset;
 if(d.action){e.preventDefault();return action(d.action,el);}
 if(d.role){s.role=d.role;if(s.role==='employee'){const own=s.tasks.find(t=>t.employee==='Арман Садыков'&&['work','travel','arrived','accepted'].includes(t.status))||s.tasks.find(t=>t.employee==='Арман Садыков');if(own)return V.selectTask(own.id,'tasks');}return V.navigate(s.role==='employee'?'tasks':s.role==='dispatcher'?'overview':'review');}
 if(d.view){s.mobile=d.view==='mobile';return V.render(true);}
 if(d.reviewTask){return V.selectTask(d.reviewTask,'inspection');}
 if(d.task){return V.selectTask(d.task);}
 if(d.employee){s.selectedEmployee=d.employee;return V.navigate('employee');}
 if(d.object){s.selectedObject=d.object;return V.navigate('object');}
 if(d.page){if(d.photoDestination)s.photoTab=d.photoDestination;if(d.screenRole==='employee'&&V.current()?.employee!=='Арман Садыков'){const own=s.tasks.find(t=>t.employee==='Арман Садыков'&&['work','travel','arrived','accepted'].includes(t.status))||s.tasks.find(t=>t.employee==='Арман Садыков');if(own)V.selectTask(own.id,null);}if(d.page==='inspection'&&V.current().status!=='review'){const review=s.tasks.find(t=>t.status==='review');if(review)V.selectTask(review.id,null);}return V.navigate(d.page,d.screenRole);}
 if(d.modal)return modal(d.modal);
 const changes={filter:'filter',orderFilter:'orderFilter',reviewFilter:'reviewFilter',photoTab:'photoTab',taskTab:'taskTab',day:'calendarDay',planningDay:'planningDay'};
 for(const [key,dest]of Object.entries(changes))if(d[key]!==undefined){s[dest]=['day','planningDay'].includes(key)?Number(d[key]):d[key];V.render(true);return;}
});
document.addEventListener('change',e=>{const el=e.target,s=V.state;
 if(el.dataset.check!==undefined){if(['done','review'].includes(V.current().status)){V.render(true);return V.toast('Переданный отчёт доступен для просмотра','amber');}s.checks[Number(el.dataset.check)]=el.checked;eventSaved();V.render(true);return;}
 if(el.dataset.setting){s.settings[el.dataset.setting]=el.type==='checkbox'?el.checked:el.value;V.save();V.toast('Правило сохранено в макете');return;}
 if(el.matches('[data-import-file]')&&el.files.length){s.importFileName=el.files[0].name;s.importStage='preview';V.render();return;}
 if(el.matches('[data-create-attachments]')){const label=document.getElementById('create-attachment-names');if(label)label.textContent=[...el.files].map(f=>f.name).join(', ');}
});
document.addEventListener('input',e=>{const el=e.target,s=V.state;if(el.dataset.draft){if(['done','review'].includes(V.current().status))return;s[el.dataset.draft]=el.value;V.storeEvidence();V.save();}if(el.matches('[data-order-search]')){s.orderSearch=el.value;const pos=el.selectionStart;V.render(true);const input=document.querySelector('[data-order-search]');input?.focus();input?.setSelectionRange(pos,pos);}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')V.closeModal();if(e.key==='Enter'&&e.target.matches('[role="button"][data-task]')){e.preventDefault();V.selectTask(e.target.dataset.task);}if(e.key==='Tab'&&document.querySelector('.modal')){const nodes=[...document.querySelectorAll('.modal button:not(:disabled),.modal input,.modal select,.modal textarea')].filter(el=>el.offsetParent!==null);if(!nodes.length)return;if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}}});
document.addEventListener('submit',e=>{const form=e.target;if(!form.id)return;e.preventDefault();if(!form.checkValidity()){form.reportValidity();return;}const f=Object.fromEntries(new FormData(form)),s=V.state,t=V.current();
 switch(form.id){
 case 'login-form':return submitAccessForm(form,()=>login(form,f,s),message=>loginError(form,message));
 case 'owner-recovery-form':return submitAccessForm(form,()=>createOwnerRecoveryLink(form,f,s),message=>formError(form,'owner-recovery-error',message));
 case 'owner-reset-form':return submitAccessForm(form,()=>resetOwnerPassword(form,f,s),message=>formError(form,'owner-reset-error',message));
 case 'change-password-form':return submitAccessForm(form,()=>changePassword(form,f,s),message=>changePasswordError(form,message));
 case 'register-form':return submitAccessForm(form,()=>register(form,f,s),message=>V.toast(message,'amber'));
 case 'pin-form':rememberQuickAccess('pin');V.navigate('tasks','employee');V.toast('Выбран быстрый доступ по PIN в макете.');break;
 case 'create-task-form':{const object=s.objects.find(o=>o.name===f.object);const id=String(Math.max(1048,...s.tasks.map(t=>parseInt(t.id)||0))+1);s.tasks.unshift({id,title:f.title,object:f.object,address:object?.address||'',employee:f.employee,status:'assigned',priority:f.priority,time:f.time,due:f.time,tag:'Вручную',estimate:f.estimate,description:f.description,date:f.date});V.navigate('orders');V.toast('Заявка №'+id+' создана и назначена');break;}
 case 'settings-form':s.settings={...s.settings,...f,connectionAlerts:!!form.elements.connectionAlerts?.checked,radius:Number(f.radius),geoPolicy:f.geoPolicy,requiredPhotos:form.elements.requiredPhotos.checked,notifications:form.elements.notifications.checked};V.save();V.toast('Настройки компании сохранены');break;
 case 'late-form':s.lastLate={reason:f.reason,arrival:f.arrival};eventSaved();V.closeModal();V.render(true);V.toast(s.offline?'Сообщение сохранено. Диспетчер ещё не уведомлён.':'Диспетчер уведомлён. Срок задачи не изменён.');break;
 case 'urgent-form':s.shiftPaused=true;s.employees.find(e=>e.id==='e1').status='away';s.tasks.forEach(x=>{if(x.employee==='Арман Садыков'){if(['work','arrived','travel'].includes(x.status)){x.previousStatus=x.status;x.status='paused';}else if(['assigned','accepted'].includes(x.status)){x.employee='Ожидает назначения';x.status='assigned';}}});s.urgentSafe=f.safe==='yes';eventSaved();V.navigate('shift');V.toast(s.offline?'Уход сохранён. Уведомление ожидает отправки.':f.safe==='no'?'Объект требует внимания. Диспетчер уведомлён.':'Смена приостановлена. Задания переданы диспетчеру.','amber');break;
 case 'pause-form':if(!['work','travel','arrived','accepted'].includes(t.status)){V.closeModal();V.toast('Пауза доступна для текущей работы','amber');break;}t.previousStatus=t.status;t.status='paused';t.pauseReason=f.reason;eventSaved();V.closeModal();V.render(true);V.toast('Работа приостановлена, результат сохранён');break;
 case 'assignment-form':t.employee=f.employee;t.status='assigned';t.handover=f.comment;eventSaved();V.navigate(s.role==='employee'?'tasks':'orders');V.toast('Работа передана: '+f.employee);break;
 case 'emergency-form':s.tasks.filter(x=>x.employee==='Арман Садыков'&&['work','arrived','travel'].includes(x.status)).forEach(x=>{x.previousStatus=x.status;x.status='paused';});let emergency=s.tasks.find(x=>x.id==='1046');emergency.status='accepted';emergency.employee='Арман Садыков';eventSaved();V.selectTask('1046');V.toast('Аварийный выезд принят. Предыдущая работа приостановлена.');break;
 case 'decline-emergency-form':eventSaved();V.closeModal();V.toast('Причина отказа сохранена'+(s.offline?' и ожидает отправки':''));break;
 case 'shift-end-form':if(f.decision==='extend'){s.shiftExtended=true;V.save();V.closeModal();V.toast('Продолжение смены зафиксировано отдельно');}else {s.shiftActive=false;s.shiftPaused=false;const active=s.tasks.filter(x=>x.employee==='Арман Садыков'&&['work','travel','arrived'].includes(x.status));active.forEach(x=>{x.previousStatus=x.status;x.status='paused';});eventSaved();if(f.decision==='handover'){if(active[0])V.selectTask(active[0].id,null);modal('handover');}else{V.navigate('shift');V.toast('Смена завершена. Незавершённая работа сохранена.');}}break;
 case 'reject-form':t.status='paused';t.reworkReason=f.comment;t.tag='Требует доработки';s.reviewed=true;V.save();V.navigate('review');V.toast('Отчёт возвращён с причиной. Доработка ожидает назначения.');break;
 case 'profile-form':s.profileName=f.name;s.profileEmail=f.email;V.save();V.closeModal();V.render(true);V.toast('Данные профиля сохранены в макете');break;
 case 'problem-form':s.problem={reason:f.reason,comment:f.comment};eventSaved();V.closeModal();V.toast(s.offline?'Проблема сохранена и ожидает отправки':'Проблема зафиксирована для диспетчера');break;
 case 'manual-arrival-form':if(t.status!=='travel'){V.closeModal();V.toast('Прибытие доступно во время поездки','amber');break;}t.status='arrived';t.arrivalException=f.reason;eventSaved();V.navigate('task');V.toast('Прибытие отмечено с причиной. Требуется проверка.');break;
 case 'employee-form':return submitAccessForm(form,()=>addEmployee(form,f,s),message=>V.toast(message,'amber'));
 case 'object-form':s.objects.push({id:'o'+Date.now(),name:f.name,address:f.address,type:f.type,contact:f.contact,tasks:0});V.navigate('objects');V.toast('Объект добавлен');break;
 case 'plan-form':s.plans=s.plans||[];s.plans.push({title:f.title,object:f.object,repeat:f.repeat,time:f.time,holiday:f.holiday});V.navigate('planning');V.toast('Повторяющаяся работа добавлена в план');break;
 case 'holiday-form':s.customHolidays=s.customHolidays||[];s.customHolidays.push({name:f.name,date:f.date});V.navigate('holidays');V.toast('Выходной добавлен: '+f.date);break;
 case 'filters-form':s.orderFilter=f.status;s.orderSearch=f.search;V.navigate('orders');break;
 default:V.toast('Изменения сохранены в макете');
 }
});
})();
