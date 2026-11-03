(function () {
'use strict';
const ICONS = {
 'arrow-right':'<path d="M5 12h14M13 6l6 6-6 6"/>',
 'arrow-left':'<path d="M19 12H5m6-6-6 6 6 6"/>',
 'arrow-up-right':'<path d="M7 17 17 7M7 7h10v10"/>',
 'chevron-right':'<path d="m9 5 7 7-7 7"/>','chevron-down':'<path d="m6 9 6 6 6-6"/>',
 check:'<path d="m5 12 4 4L19 6"/>','check-circle':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 'map-pin':'<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
 camera:'<path d="M14 4H9L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3.5"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h1m3 0h1m3 0h1"/>',
 wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".6"/>',
 'wifi-off':'<path d="m3 3 18 18M2 8a16 16 0 0 1 3-2m4-2a16 16 0 0 1 13 4M5 12a11 11 0 0 1 4-2m6 0a11 11 0 0 1 4 2m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".6"/>',
 refresh:'<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
 download:'<path d="M12 3v12m-4-4 4 4 4-4M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
 upload:'<path d="M12 16V3m-4 4 4-4 4 4M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
 briefcase:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 12a22 22 0 0 0 18 0m-9 0v3"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/>',
 users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v3m1-17a3 3 0 0 1 0 6m3 11v-3a5 5 0 0 0-2-4"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9m-8 12a2 2 0 0 0 4 0"/>',
 phone:'<path d="m6 3 3 4-2 3a16 16 0 0 0 7 7l3-2 4 3v3C10 22 2 14 3 3Z"/>',
 shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
 'alert-triangle':'<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.5"/>',
 'file-text':'<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Zm0 0v6h6M8 12h8m-8 4h8"/>',
 play:'<path d="m8 4 12 8-12 8Z"/>',pause:'<path d="M8 4v16m8-16v16"/>',
 navigation:'<path d="m21 3-7 18-3-8-8-3Z"/>',
 settings:'<path d="m9 3-1 3-3 1-2 3 2 2v3l2 3h3l2 3 3-1 1-3 3-1 2-3-2-2V8l-2-3h-3l-2-3Z"/><circle cx="12" cy="12" r="3"/>',
 battery:'<rect x="2" y="6" width="17" height="12" rx="2"/><path d="M22 10v4M5 9v6m3-6v6m3-6v6m3-6v6"/>',
 'check-square':'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
 clipboard:'<path d="M8 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="8" y="2" width="8" height="6" rx="2"/><path d="M7 12h10m-10 5h7"/>',
 activity:'<path d="M2 12h4l3-8 6 16 3-8h4"/>',
 layers:'<path d="m12 2 10 6-10 6L2 8Zm-10 11 10 6 10-6M2 18l10 5 10-5"/>',
 search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
 filter:'<path d="M3 4h18l-7 8v7l-4 2V12Z"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
 repeat:'<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 zap:'<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
 sliders:'<path d="M4 3v6m0 4v8m8-18v12m0 4v2m8-18v3m0 4v11M1 9h6m2 6h6m2-9h6"/>',
 edit:'<path d="m16 3 5 5-12 12-6 1 1-6Zm-3 3 5 5"/>',
 building:'<path d="M4 22V4l12-2v20M16 8h5v14M2 22h21M8 7h4m-4 4h4m-4 4h4m-4 4h4"/>',
 key:'<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-6-6 3-3m0 6 3-3"/>',
 'file-spreadsheet':'<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Zm0 0v6h6"/><path d="M7 12h10v7H7Zm5 0v7m-5-3.5h10"/>',
 plus:'<path d="M12 4v16M4 12h16"/>',minus:'<path d="M4 12h16"/>',x:'<path d="m6 6 12 12M6 18 18 6"/>',
 menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
 smartphone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/>',
 monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
 logout:'<path d="M9 4H4v16h5m5-12 4 4-4 4M8 12h12"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
 fingerprint:'<path d="M5 9a7 7 0 0 1 14 0m-17 3a10 10 0 0 1 20 0M8 12a4 4 0 0 1 8 0c0 4 1 6 3 8M5 13c0 4-1 6-2 8m5-5a12 12 0 0 1-2 6m6-10c0 5 0 7 3 10m-5-2 1 2"/>',
 chart:'<path d="M4 3v18h18M8 17v-6m5 6V7m5 10V4"/>',
 lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
 heart:'<path d="M20 4a5 5 0 0 0-8 2 5 5 0 0 0-8-2c-6 6 8 17 8 17S26 10 20 4Z"/>',
 sparkles:'<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Zm8-2v5m-2-2h4"/>',
 cloud:'<path d="M7 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5 5 0 0 1 0 11Z"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
 flag:'<path d="M4 22V3c5-4 10 4 16 0v12c-6 4-11-4-16 0"/>',
 chevrons:'<path d="m8 8 4-4 4 4m-8 8 4 4 4-4"/>'
};
const ALIASES={'shield-check':'shield','alert':'alert-triangle','bar-chart':'chart','bar-chart-2':'chart','layout-dashboard':'grid','layout-grid':'grid','file':'file-text','refresh-cw':'refresh','cloud-off':'wifi-off','more-horizontal':'menu','user-plus':'users','check-check':'check','arrow-down':'download','home':'building','map':'map-pin','wrench':'sliders','send':'navigation','checklist':'check-square','external-link':'arrow-up-right','chevron-left':'arrow-left','help-circle':'info','circle-check':'check-circle'};
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function icon(name,size=20){return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]||ICONS[ALIASES[name]]||ICONS.clipboard}</svg>`;}
const STATUS={assigned:['Назначена','gray'],accepted:['Принята в работу','blue'],travel:['В пути','blue'],arrived:['На объекте','blue'],work:['В работе','green'],review:['На проверке','amber'],done:['Принята руководителем','green'],paused:['Приостановлена','amber'],rework:['Требует доработки','red'],cancelled:['Отменена','gray']};
const DEFAULT={version:3,role:'employee',page:'login',companyName:'Астана Сервис',mobile:false,selectedTask:'1042',selectedEmployee:'e1',selectedObject:'o1',offline:false,checks:[true,true,false,false,false],photos:{before:1,after:0},evidence:{},filter:'all',orderFilter:'all',orderSearch:'',reviewFilter:'all',photoTab:'before',taskTab:'details',calendarDay:3,planningDay:1,shiftActive:true,shiftPaused:false,syncPending:0,prepared:false,queueEnabled:true,importStage:'initial',planningView:'week',reviewed:false,conflictResolved:false,analyticsRange:'week',notificationsRead:false,settings:{radius:100,geoPolicy:'flag',requiredPhotos:true,notifications:true},tasks:[
 {id:'1042',title:'Плановое обслуживание вентиляции',object:'БЦ «Астана Тауэр»',address:'Астана, проспект Кабанбай батыра, 17',status:'work',priority:'normal',time:'10:00–12:00',due:'12:00',employee:'Арман Садыков',tag:'Плановая',estimate:'1 ч 30 мин'},
 {id:'1043',title:'Проверить систему освещения',object:'ЖК «Зелёный квартал»',address:'Астана, ул. Е-10, 17',status:'assigned',priority:'high',time:'13:00–14:00',due:'14:00',employee:'Арман Садыков',tag:'По заявке',estimate:'45 мин'},
 {id:'1044',title:'Осмотр пожарных выходов',object:'Школа №85',address:'Астана, ул. Кайым Мухамедханова, 12',status:'assigned',priority:'normal',time:'15:00–16:00',due:'16:00',employee:'Арман Садыков',tag:'Плановая',estimate:'1 час'},
 {id:'1038',title:'Замена фильтров кондиционера',object:'Музей энергии',address:'Астана, проспект Мангилик Ел, 55',status:'review',priority:'normal',time:'09:00–10:00',due:'10:00',employee:'Арман Садыков',tag:'Плановая',estimate:'45 мин'},
 {id:'1037',title:'Проверка водоснабжения',object:'БЦ «Астана Тауэр»',address:'Астана, проспект Кабанбай батыра, 17',status:'done',priority:'normal',time:'08:30–09:00',due:'09:00',employee:'Арман Садыков',tag:'Осмотр',estimate:'30 мин'},
 {id:'1046',title:'Устранить протечку в тепловом узле',object:'ЖК «Зелёный квартал»',address:'Астана, ул. Е-10, 17',status:'paused',priority:'urgent',time:'10:00–12:30',due:'12:30',employee:'Марат Омаров',tag:'Авария',estimate:'2 часа'},
 {id:'1047',title:'Диагностика системы доступа',object:'Музей энергии',address:'Астана, проспект Мангилик Ел, 55',status:'travel',priority:'high',time:'11:30–13:00',due:'13:00',employee:'Алихан Беков',tag:'По заявке',estimate:'1 час'},
 {id:'1039',title:'Плановая проверка электрощита',object:'Школа №85',address:'Астана, ул. Кайым Мухамедханова, 12',status:'review',priority:'normal',time:'09:00–10:00',due:'10:00',employee:'Марат Омаров',tag:'Плановая',estimate:'1 час'},
 {id:'1040',title:'Обслуживание насосной станции',object:'ЖК «Зелёный квартал»',address:'Астана, ул. Е-10, 17',status:'review',priority:'normal',time:'08:00–09:00',due:'09:00',employee:'Дана Касымова',tag:'Повторный выезд',estimate:'1 час'}
],employees:[
 {id:'e1',name:'Арман Садыков',initials:'АС',role:'Инженер по обслуживанию',status:'busy',tasks:5,load:74,color:'green'},
 {id:'e2',name:'Дана Касымова',initials:'ДК',role:'Техник инженерных систем',status:'available',tasks:3,load:42,color:'amber'},
 {id:'e3',name:'Марат Омаров',initials:'МО',role:'Электромонтажник',status:'busy',tasks:4,load:86,color:'blue'},
 {id:'e4',name:'Алихан Беков',initials:'АБ',role:'Специалист СКУД',status:'offline',tasks:3,load:58,color:'purple'},
 {id:'e5',name:'Асель Муратова',initials:'АМ',role:'Инженер по безопасности',status:'available',tasks:2,load:31,color:'green'},
 {id:'e6',name:'Руслан Иманов',initials:'РИ',role:'Сантехник',status:'away',tasks:0,load:0,color:'amber'}
],objects:[
 {id:'o1',name:'БЦ «Астана Тауэр»',address:'проспект Кабанбай батыра, 17',type:'Бизнес-центр',tasks:3,contact:'Марат Касенов'},
 {id:'o2',name:'ЖК «Зелёный квартал»',address:'ул. Е-10, 17',type:'Жилой комплекс',tasks:4,contact:'Айнур Толеуова'},
 {id:'o3',name:'Музей энергии',address:'проспект Мангилик Ел, 55',type:'Общественный объект',tasks:2,contact:'Ерлан Сейт'},
 {id:'o4',name:'Школа №85',address:'ул. Кайым Мухамедханова, 12',type:'Образование',tasks:2,contact:'Алия Бекова'}
]};
let stored;try{stored=JSON.parse(localStorage.getItem('vektor-demo-v3')||'null');}catch{}
let state=stored?.version===3?{...structuredClone(DEFAULT),...stored}:structuredClone(DEFAULT);
state.page=location.hash.slice(1)||DEFAULT.page;
let modalName=null,toastTimer;
function current(){return state.tasks.find(t=>t.id===state.selectedTask)||state.tasks[0];}
function save(){window.Vektor?.syncOwnerCredentials?.();try{localStorage.setItem('vektor-demo-v3',JSON.stringify(state));}catch{}}
function badge(text,tone='green'){if(tone==='neutral')tone='gray';return `<span class="badge ${esc(tone)}"><span class="status-dot"></span>${esc(text)}</span>`;}
function btn(text,action,kind='primary',ico=''){return `<button type="button" class="btn btn-${esc(kind)}" data-action="${esc(action)}">${ico?icon(ico,16):''}${esc(text)}</button>`;}
function nav(text,page,kind='secondary',ico=''){return `<button type="button" class="btn btn-${esc(kind)}" data-page="${esc(page)}">${ico?icon(ico,16):''}${esc(text)}</button>`;}
function progress(n){return `<div class="progress" role="progressbar" aria-valuenow="${Math.round(n)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,n))}%"></div></div>`;}
function taskCard(t){let status=STATUS[t.status]||STATUS.assigned;const checks=t.id===state.selectedTask?state.checks:(state.evidence[t.id]?.checks||[true,true,false,false,false]);const count=checks.filter(Boolean).length;return `<article class="task-card" tabindex="0" role="button" aria-label="Открыть заявку ${esc(t.id)}: ${esc(t.title)}" data-task="${esc(t.id)}"><div class="task-card-top">${badge(status[0],status[1])}<span class="task-id">№ ${esc(t.id)}</span></div><h3>${esc(t.title)}</h3><div class="task-location">${icon('building',14)}<span><strong>${esc(t.object)}</strong><br>${esc(t.address.replace('Астана, ',''))}</span></div>${t.priority==='urgent'?'<div style="margin:4px 0 12px">'+badge('Авария','red')+'</div>':''}${t.status==='work'?'<div class="task-card-progress"><div class="progress-label"><span>Чек-лист работ</span><span>'+count+' из 5</span></div>'+progress(count*20)+'</div>':''}<div class="task-card-footer"><span>${icon('clock',13)}До ${esc(t.due)}</span><span>${esc(t.tag||'По заявке')}${icon('arrow-up-right',13)}</span></div></article>`;}
function map(compact=false){return `<div class="schematic-map ${compact?'':'map-full'}"><svg viewBox="0 0 600 360" role="img" aria-label="Схематичная демонстрационная карта объектов Астаны" preserveAspectRatio="xMidYMid slice"><defs><pattern id="blocks" width="115" height="88" patternUnits="userSpaceOnUse" patternTransform="rotate(-14)"><rect width="115" height="88" fill="#eef1e6"/><rect x="9" y="9" width="42" height="28" rx="4" fill="#dfe5d7"/><rect x="59" y="9" width="44" height="61" rx="4" fill="#e2e8da"/><rect x="9" y="44" width="42" height="26" rx="4" fill="#dce4d3"/><path d="M0 81h115M110 0v88" stroke="#fff" stroke-width="9"/></pattern><filter id="pinshadow"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity=".12"/></filter></defs><rect width="600" height="360" fill="url(#blocks)"/><path d="M-40 250c190-180 120-100 320-100s220-70 360-140" stroke="#ccdfd7" stroke-width="48" fill="none"/><path d="M-30 275c190-180 120-100 320-100s220-70 360-140" stroke="#f9faf3" stroke-width="6" fill="none"/><path d="M40 375 485-20M-20 110l650 182" stroke="#fff" stroke-width="19"/><path d="M40 375 485-20M-20 110l650 182" stroke="#e1e7d6" stroke-width="1" fill="none"/><path d="M165 280 257 198 332 222 414 146" stroke="#8eae79" stroke-width="13" stroke-opacity=".2" fill="none"/><path d="M165 280 257 198 332 222 414 146" stroke="#48856a" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="7 6" fill="none"/><g font-family="Arial,sans-serif" font-size="10" fill="#9ca993"><text x="280" y="78" transform="rotate(-16 280 78)">РЕКА ЕСИЛЬ</text><text x="62" y="155" transform="rotate(16 62 155)">пр. Кабанбай батыра</text><text x="391" y="311">ЗЕЛЁНЫЙ КВАРТАЛ</text><text x="69" y="41">ЛЕВЫЙ БЕРЕГ</text></g><g filter="url(#pinshadow)"><circle cx="165" cy="280" r="25" fill="#21745c" opacity=".13"/><circle cx="165" cy="280" r="10" fill="#21745c" stroke="white" stroke-width="4"/><g transform="translate(394 104)"><rect width="40" height="40" rx="13" fill="#173d35"/><path d="m14 40 6 9 6-9" fill="#173d35"/><path d="M11 28V12h18v16M15 16h3m4 0h3m-10 5h3m4 0h3m-10 5h3" stroke="#d9edb4" fill="none" stroke-width="1.5"/></g><g transform="translate(270 244)"><circle r="15" fill="white"/><path d="M-5 5V-7H5V5M-8 5H8M-2-3h4m-4 4h4" stroke="#91a97c" stroke-width="1.5" fill="none"/></g><g transform="translate(455 260)"><circle r="15" fill="white"/><path d="M-5 5V-7H5V5M-8 5H8M-2-3h4m-4 4h4" stroke="#91a97c" stroke-width="1.5" fill="none"/></g></g><g transform="translate(304 64)"><rect width="185" height="29" rx="8" fill="white"/><text x="12" y="19" font-family="Arial,sans-serif" font-size="10" fill="#61734f">БЦ «Астана Тауэр» · 42 м</text></g></svg><div class="map-legend"><span class="row"><i class="map-dot"></i>Вы на объекте <span style="color:#b0bca2">·</span> ${compact?'3 объекта':'Точность 12 м'}</span></div><span class="map-caption">Схема маршрута · демо-геопозиция</span></div>`;}
let photoId=0;
function photo(kind='before'){const after=kind==='after',id='p'+(++photoId);return `<div class="demo-photo"><svg viewBox="0 0 500 340" role="img" aria-label="${after?'Пример оборудования после обслуживания':'Пример оборудования до обслуживания'}"><defs><linearGradient id="${id}bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#b8beb6"/><stop offset="1" stop-color="#e5e8de"/></linearGradient><linearGradient id="${id}metal" x1="0" x2="1"><stop stop-color="#abb3a8"/><stop offset=".5" stop-color="#e6e9de"/><stop offset="1" stop-color="#adb6a7"/></linearGradient><filter id="${id}grain"><feTurbulence type="fractalNoise" baseFrequency=".6" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feBlend in="SourceGraphic" mode="multiply"/></filter></defs><rect width="500" height="340" fill="url(#${id}bg)"/><path d="M0 65h500M0 160h500M0 255h500M75 0v340M350 0v340" stroke="#aeb7a5" opacity=".3"/><path d="M390-10v84h-70v38M60 340V108h44" fill="none" stroke="#747e6e" stroke-width="18"/><path d="M390-10v84h-70v38M60 340V108h44" fill="none" stroke="#c1c9b7" stroke-width="12"/><rect x="93" y="92" width="285" height="204" rx="5" fill="#57614d" opacity=".2"/><rect x="100" y="84" width="272" height="201" rx="4" fill="url(#${id}metal)" stroke="#8b9681"/><path d="M100 115h272M285 84v201" stroke="#96a28a"/><rect x="118" y="132" width="147" height="129" rx="2" fill="${after?'#9da896':'#838d7a'}"/>${Array.from({length:15},(_,i)=>`<path d="M124 ${140+i*7.5}h135" stroke="${after?'#d3dac8':'#acb39e'}" stroke-width="4"/>`).join('')}<circle cx="327" cy="158" r="19" fill="#8e9b83"/><circle cx="327" cy="158" r="14" fill="#e2e9d6"/><path d="m327 158 7-8" stroke="#6f7e61" stroke-width="2"/><rect x="303" y="199" width="49" height="35" rx="3" fill="#a0ac93"/><circle cx="315" cy="215" r="4" fill="${after?'#77965b':'#baab70'}"/><circle cx="339" cy="215" r="4" fill="#d7dfcb"/><rect x="119" y="96" width="89" height="8" rx="1" fill="#7e8d72" opacity=".6"/><text x="294" y="265" fill="#76856c" font-size="8" font-family="Arial">VENT • SYSTEM</text>${after?'':'<ellipse cx="182" cy="255" rx="63" ry="9" fill="#716e4d" opacity=".2"/><path d="m126 184 58-9m-44 46 89-9m-93 24 56-3" stroke="#6f7456" opacity=".24" stroke-width="4"/>'}<rect width="500" height="340" fill="#d6dec7" opacity=".05" filter="url(#${id}grain)"/></svg><div class="photo-watermark"><strong>03.11.2026 · ${after?'11:07':'10:21'} · Арман Садыков</strong><br>БЦ «Астана Тауэр» · 51.1281, 71.4303</div><span class="photo-demo">Пример снимка</span></div>`;}
const h={icon,esc,badge,btn,nav,progress,taskCard,map,photo};
const PAGES={tasks:['Мои задачи','clipboard','employee','Задания и текущая работа'],task:['Карточка задания','file-text','employee','Статусы, требования, история'],checklist:['Чек-лист работ','check-square','employee','Пункты и комментарии'],photos:['Фотоотчёт','camera','employee','Снимки до и после'],report:['Результат выезда','check-circle','employee','Проверка и завершение'],route:['Маршрут и прибытие','map-pin','employee','Геозона и отметка на объекте'],calendar:['Моё расписание','calendar','employee','Работы по дням'],sync:['Работа без сети','wifi-off','employee','Загрузка и синхронизация'],shift:['Моя смена','clock','employee','Пауза, срочный уход, передача'],profile:['Мой профиль','user','employee','Доступ и настройки устройства'],notifications:['Уведомления','bell','employee','События и изменения'],overview:['Обзор работы','grid','dispatcher','Заявки, команда и карта'],orders:['Все заявки','clipboard','dispatcher','Поиск, сроки и исполнители'],create:['Создать заявку','plus','dispatcher','Объект, назначение и отчёт'],planning:['Плановые работы','calendar','dispatcher','Неделя, месяц, повторения'],queue:['Автоназначение','layers','dispatcher','Очередь и правила выдачи'],team:['Команда','users','dispatcher','Доступность и нагрузка'],employee:['Карточка сотрудника','user','dispatcher','Смена и назначения'],objects:['Объекты','building','dispatcher','Справочник мест работы'],object:['Карточка объекта','map-pin','dispatcher','Доступ, контакты и история'],import:['Импорт работ','file-spreadsheet','dispatcher','Проверка и импорт календаря'],review:['Приёмка работ','check-circle','manager','Очередь отчётов'],inspection:['Проверка результата','image','manager','Сравнение до и после'],analytics:['Аналитика','chart','manager','Сроки, качество и загрузка'],conflicts:['Конфликты данных','refresh','manager','Решение после офлайна'],settings:['Настройки компании','settings','manager','Правила и доступ'],holidays:['Календарь компании','calendar','manager','Выходные и дежурства'],login:['Вход в компанию','lock','auth','Доступ сотрудника'],register:['Регистрация компании','building','auth','Начало работы владельца'],'owner-recovery':['Восстановление доступа владельца','lock','flow','Рабочая почта'],'owner-reset':['Новый пароль владельца','lock','flow','Восстановление доступа'],'change-password':['Смена временного пароля','lock','flow','Первый вход сотрудника'],pin:['Быстрый вход','fingerprint','auth','PIN и биометрия'],screens:['Все экраны','grid','all','Каталог макета']};
const NAV={employee:['tasks','calendar','shift','sync','notifications','profile'],dispatcher:['overview','orders','planning','queue','team','objects','import'],manager:['review','analytics','conflicts','team','objects','holidays','settings']};
const MOBILENAV={employee:['tasks','calendar','shift','sync','profile'],dispatcher:['overview','orders','create','planning','team'],manager:['review','analytics','conflicts','team','settings']};
const MOBILELABEL={tasks:'Задания',calendar:'План',shift:'Смена',sync:'Связь',profile:'Профиль',overview:'Обзор',orders:'Заявки',create:'Создать',planning:'План',team:'Команда',review:'Приёмка',analytics:'Отчёты',conflicts:'Конфликты',settings:'Настройки'};
const ROLELABEL={employee:'Сотрудник',dispatcher:'Диспетчер',manager:'Руководитель'};
const USER={employee:['Арман Садыков','АС'],dispatcher:['Алия Нурланова','АН'],manager:['Динара Ахметова','ДА']};
function signedInEmployee() {
  return state.role === 'employee' && state.employees.find(employee => employee.id === state.signedInEmployeeId);
}
function workspaceUser() {
  const employee = signedInEmployee();
  if (employee) return [employee.name, employee.initials];
  if (state.role === 'dispatcher' && state.ownerName) {
    const initials = state.ownerName.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    return [state.ownerName, initials];
  }
  return USER[state.role];
}
function roleCount(page){if(page==='tasks')return state.tasks.filter(t=>t.employee===workspaceUser()[0]&&t.status!=='done').length;if(page==='review')return state.tasks.filter(t=>t.status==='review').length;if(page==='conflicts')return state.conflictResolved?0:1;return null;}
function navItem(page){const p=PAGES[page],n=roleCount(page);return `<button class="nav-link ${state.page===page?'active':''}" data-page="${page}">${icon(p[1],18)}<span>${p[0]}</span>${n?`<span class="nav-count">${n}</span>`:''}</button>`;}
function brand(){return `<span class="brand-mark"><svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 7h8l3 10L26 7v9L15 27z" fill="currentColor"/></svg></span>`;}
function sidebar(){return `<aside class="sidebar"><button style="border:0;background:none;text-align:left" class="brand" data-page="${state.role==='employee'?'tasks':state.role==='dispatcher'?'overview':'review'}">${brand()}<span>ВЕКТОР<span class="brand-sub" style="display:block">ВЫЕЗДНЫЕ РАБОТЫ</span></span></button><div class="company-switch"><span class="company-icon">${icon('building',17)}</span><span>${esc(state.companyName)}<small>Рабочее пространство</small></span>${icon('chevrons',12)}</div><div class="nav-label">${ROLELABEL[state.role]}</div><nav class="nav-list" aria-label="Основная навигация">${NAV[state.role].map(navItem).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-note"><strong>Всё под контролем</strong>Задания, команда и результат — в едином рабочем пространстве.</div><button class="nav-link" data-page="screens">${icon('grid',17)}Все экраны макета</button><div class="sidebar-user"><span class="avatar">${esc(workspaceUser()[1])}</span><span><strong>${esc(workspaceUser()[0])}</strong><small>${ROLELABEL[state.role]}</small></span><button aria-label="Открыть профиль" data-page="profile">${icon('chevron-right',16)}</button></div></div></aside>`;}
function toolbar(){return `<div class="prototype-brand"><span class="proto-logo">${icon('layers',17)}</span><div><span class="proto-title">Вектор · интерактивный макет</span><span class="proto-caption">30 экранов · мобильная адаптация</span></div></div><div class="role-switch" role="group" aria-label="Роль пользователя">${Object.entries(ROLELABEL).map(([key,label])=>`<button class="${state.role===key?'active':''}" aria-pressed="${state.role===key}" data-role="${key}">${label}</button>`).join('')}</div><div class="proto-tools"><div class="view-switch" role="group" aria-label="Размер экрана"><button aria-label="Компьютер" title="Компьютер" data-view="desktop" class="${!state.mobile?'active':''}">${icon('monitor',16)}</button><button aria-label="Мобильный экран" title="Мобильный экран" data-view="mobile" class="${state.mobile?'active':''}">${icon('smartphone',16)}</button></div><span class="proto-divider"></span><button class="proto-catalog" data-page="screens">${icon('grid',14)}Все экраны</button></div>`;}
function topbar(){return `<header class="topbar"><div class="breadcrumbs">${esc(state.companyName)} ${icon('chevron-right',11)} <strong>${PAGES[state.page]?.[0]||'Рабочее пространство'}</strong></div><div class="mobile-only row"><button class="icon-button" aria-label="Открыть меню" data-action="open-menu" style="border:0;width:25px">${icon('menu',19)}</button><span class="mobile-brand">${brand()}ВЕКТОР</span></div><div class="header-actions"><span class="header-date">Вторник, 3 ноября</span><button class="connection ${state.offline?'offline':''}" data-page="sync"><i class="connection-dot"></i>${state.offline?'Без сети':'На связи'}${state.syncPending?' · '+state.syncPending:''}</button><span class="topbar-divider"></span><button class="icon-button notification-button" aria-label="Уведомления" data-page="notifications">${icon('bell',17)}</button><button class="avatar" aria-label="Мой профиль" data-page="profile" style="border:0">${esc(workspaceUser()[1])}</button></div></header>`;}
function mobileNav(){return `<nav class="mobile-nav" aria-label="Навигация мобильного приложения">${MOBILENAV[state.role].map(page=>`<button data-page="${page}" class="${state.page===page?'active':''}" aria-label="${PAGES[page][0]}">${icon(PAGES[page][1],19)}<span>${MOBILELABEL[page]}</span></button>`).join('')}</nav>`;}
const CATALOG_ROUTES = [
  {
    title: 'Создание и назначение заявки',
    steps: [
      ['overview', 'Диспетчер открывает обзор работы.'],
      ['create', 'Нажмите «Создать заявку», выберите объект и исполнителя.'],
      ['orders', 'Сохранённая заявка появится в списке.'],
      ['tasks', 'Переключитесь на сотрудника, чтобы открыть его задания.']
    ]
  },
  {
    title: 'Выезд и сдача работы',
    steps: [
      ['tasks', 'Для полного пути выберите назначенную заявку, например №1043.'],
      ['task', 'Нажмите «Принять задачу», затем «Выехать на объект».'],
      ['route', 'Нажмите «Я на месте», чтобы вернуться к заданию.'],
      ['photos', 'В карточке нажмите «Начать работу». Если фото «до» ещё нет, добавьте его и вернитесь к заданию.'],
      ['checklist', 'Начните работу из карточки и отметьте все пункты.'],
      ['photos', 'Перейдите к фото «после» и добавьте снимок.', 'Фотоотчёт · после работы'],
      ['report', 'Откройте итоговый отчёт и нажмите «Завершить работу».']
    ]
  },
  {
    title: 'Приёмка отчёта',
    steps: [
      ['review', 'После сдачи отчёта переключитесь на руководителя.'],
      ['inspection', 'Выберите отчёт и проверьте снимки и чек-лист.'],
      ['review', 'Примите работу или верните её на доработку с причиной.']
    ]
  },
  {
    title: 'Команда и объекты',
    steps: [
      ['team', 'Откройте раздел «Команда» в меню.'],
      ['employee', 'Выберите сотрудника, чтобы увидеть его доступ и назначения.'],
      ['objects', 'Для перехода к объектам откройте одноимённый раздел меню.'],
      ['object', 'Выберите объект. Из карточки можно перейти к созданию заявки.']
    ]
  },
  {
    title: 'Планирование и импорт',
    steps: [
      ['planning', 'Откройте «Плановые работы» в меню диспетчера.'],
      ['import', 'Нажмите «Импорт Excel», пройдите проверку и подтвердите демо-импорт.'],
      ['orders', 'Импортированные заявки видны в списке.'],
      ['queue', 'Настройки очереди доступны в отдельном разделе «Автоназначение».']
    ]
  },
  {
    title: 'Регистрация и вход сотрудника',
    steps: [
      ['login', 'На стартовом экране выберите «Регистрация компании».'],
      ['register', 'Владелец создаёт компанию.'],
      ['team', 'Добавьте сотрудника и передайте ссылку, логин и временный пароль.'],
      ['login', 'Сотрудник открывает ссылку компании и входит с выданными данными.'],
      ['change-password', 'При первом входе сотрудник задаёт личный пароль.'],
      ['pin', 'Выберите быстрый доступ или настройте его позже.'],
      ['tasks', 'После входа открывается список заданий.']
    ]
  },
  {
    title: 'Восстановление пароля владельца',
    steps: [
      ['login', 'Нажмите «Забыли пароль?», затем «Я владелец».'],
      ['owner-recovery', 'Введите рабочую почту и получите демо-ссылку.'],
      ['owner-reset', 'Откройте полученную ссылку и задайте новый пароль.'],
      ['login', 'Войдите с новым паролем.']
    ]
  },
  {
    title: 'Расписание, смена и связь',
    steps: [
      ['tasks', 'Начните с рабочего экрана сотрудника.'],
      ['calendar', 'Кнопка «Расписание» открывает план работ по дням.'],
      ['profile', 'Профиль открывается из меню. Из него доступны смена и синхронизация.'],
      ['shift', 'Выберите «Моя смена» для действий со сменой.'],
      ['sync', 'Выберите «Синхронизация» в профиле или нажмите индикатор связи.'],
      ['notifications', 'Откройте уведомления кнопкой с колокольчиком.']
    ]
  },
  {
    title: 'Разделы руководителя',
    steps: [
      ['review', 'Приёмка открывается при переключении на руководителя.'],
      ['conflicts', 'На приёмке нажмите «Конфликты синхронизации».'],
      ['analytics', 'Для просмотра показателей выберите «Аналитика» в меню.'],
      ['settings', 'Правила и доступ команды находятся в настройках компании.'],
      ['holidays', 'Выходные и дежурства открываются через «Календарь компании» в меню.']
    ]
  }
];

function catalogRoutes() {
  return `<section class="catalog-routes" aria-labelledby="catalog-routes-title">
    <h2 id="catalog-routes-title">Карта переходов</h2>
    <p class="muted">Шаги идут сверху вниз. Нажмите название, чтобы открыть экран. Шаги смены пароля открываются из соответствующего сценария.</p>
    <div class="catalog-routes-grid">
      ${CATALOG_ROUTES.map(({title, steps}) => `<article class="catalog-route card">
        <h3>${esc(title)}</h3>
        <ol class="catalog-route-steps" role="list">
          ${steps.map(([page, action, label], index) => {
            const [name, , role] = PAGES[page];
            const title = esc(label || name);
            const step = page === 'change-password' || page === 'owner-reset'
              ? `<span class="catalog-route-link catalog-route-static">${title}</span>`
              : `<button type="button" class="catalog-route-link" data-page="${page}" data-screen-role="${role}" ${label && page === 'photos' ? 'data-photo-destination="after"' : ''}>${title}${icon('chevron-right', 15)}</button>`;
            return `<li class="catalog-route-step"><span class="catalog-route-number" aria-hidden="true">${index + 1}</span>${step}<p class="catalog-route-hint muted">${esc(action)}</p></li>`;
          }).join('')}
        </ol>
      </article>`).join('')}
    </div>
  </section>`;
}
function screens(){return `<div class="page-heading catalog-heading"><div><div class="eyebrow">КАРТА ПРОДУКТА</div><h1>Один сервис. Вся команда.</h1><p>30 экранов, три роли и полный путь от заявки до принятой работы.</p></div>${btn('Начать заново','reset-demo','secondary','refresh')}</div><div class="info-box green" style="margin-bottom:26px">${icon('smartphone',20)}<div><strong>Каждый экран адаптирован к телефону</strong><p>Откройте экран и переключите размер в верхней панели. Фото, геопозиция и вход показаны на демонстрационных данных.</p></div></div>${catalogRoutes()}${[['employee','01 · СОТРУДНИК','Работа в вашем ритме'],['dispatcher','02 · ДИСПЕТЧЕР','Команда и объекты под контролем'],['manager','03 · РУКОВОДИТЕЛЬ','Качество, результат и решения'],['auth','04 · ПОДКЛЮЧЕНИЕ','Начало работы']].map(([role,label,title])=>`<section class="catalog-group"><div class="eyebrow">${label}</div><h2>${title}</h2><div class="catalog-grid">${Object.entries(PAGES).filter(([_,p])=>p[2]===role).map(([page,p],i)=>`<button class="screen-card" data-page="${page}" data-screen-role="${role}"><span class="screen-card-icon">${icon(p[1],17)}</span><span><strong>${p[0]}</strong><small>${p[3]}</small></span><span class="screen-number">${String(i+1).padStart(2,'0')}</span></button>`).join('')}</div></section>`).join('')}`;}
function accessPage(page) {
  if (window.Vektor?.hasPendingPasswordChange?.()) return 'change-password';
  return page === 'change-password' ? 'login' : page;
}
function render(keepScroll=false){
window.Vektor?.syncOwnerCredentials?.();
const page = accessPage(state.page);
if (state.page !== page) {
  state.page = page;
  history.replaceState(null, '', '#' + page);
}
const scroll=document.querySelector('.content-scroll');const y=keepScroll&&scroll?scroll.scrollTop:0;photoId=0;document.getElementById('prototype-bar').innerHTML=toolbar();document.getElementById('viewport').classList.toggle('is-mobile',state.mobile);let content;const view=window.VektorViews[state.page];try{content=state.page==='screens'?screens():view?view(viewState(),h):screens();}catch(e){console.error(e);content=`<div class="empty-state"><h2>Экран временно недоступен</h2>${nav('Все экраны','screens')}</div>`;}
const auth=['login','register','owner-recovery','owner-reset','change-password','pin'].includes(state.page);
document.getElementById('app').innerHTML=auth?`<div class="main-column" style="height:100%"><main class="content-scroll"><div class="page-content" style="max-width:1250px">${content}</div></main></div>`:`<div class="app-layout">${sidebar()}<div class="main-column">${topbar()}${state.offline?`<div class="offline-banner">${icon('wifi-off',13)}Работа без сети · изменения сохраняются на устройстве</div>`:''}<main class="content-scroll" id="main-content"><div class="page-content" data-current-page="${state.page}">${content}</div></main>${mobileNav()}</div></div>`;
const newScroll=document.querySelector('.content-scroll');if(newScroll)newScroll.scrollTop=y;document.title=(PAGES[state.page]?.[0]||'Макет')+' — Вектор';save();}
function viewState() {
  const employee = signedInEmployee();
  const view = employee ? {...state, profileName: employee.name, profileEmail: ''} : state;
  if (state.page === 'tasks' || state.page === 'calendar') {
    return {...view, tasks: state.tasks.filter(task => task.employee === workspaceUser()[0])};
  }
  return view;
}
function navigate(page,role){if(page!=='login')window.Vektor.ownerLoginEmployeeId=null;if(role&&role!=='auth'&&role!=='all')state.role=role;state.page=accessPage(PAGES[page]?page:'screens');modalName=null;document.getElementById('modal-root').innerHTML='';if(location.hash.slice(1)!==state.page)history.pushState(null,'','#'+state.page);render();}
function selectTask(id,page='task'){storeEvidence();state.selectedTask=id;const found=state.evidence[id],t=current();state.checks=found?.checks||(['done','review'].includes(t.status)?[true,true,true,true,true]:t.status==='work'?[true,true,false,false,false]:[false,false,false,false,false]);state.photos=found?.photos||(['done','review'].includes(t.status)?{before:2,after:2}:t.status==='work'?{before:1,after:0}:{before:0,after:0});state.reportComment=found?.reportComment||'';state.checklistComment=found?.checklistComment||'';state.taskTab='details';if(page)navigate(page);}
function storeEvidence(){state.evidence[state.selectedTask]={checks:[...state.checks],photos:{...state.photos},reportComment:state.reportComment||'',checklistComment:state.checklistComment||''};}
function toast(message,type='success'){clearTimeout(toastTimer);document.getElementById('toast-root').innerHTML=`<div class="toast ${type}" role="status">${icon(type==='error'?'alert-triangle':'check-circle',18)}${esc(message)}</div>`;toastTimer=setTimeout(()=>document.getElementById('toast-root').innerHTML='',4200);}
function showModal(title,body,wide=false){modalName=title;document.getElementById('modal-root').innerHTML=`<div class="modal-backdrop" data-dismiss="true"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="modal-close" data-action="close-modal" aria-label="Закрыть">${icon('x',17)}</button></div><div class="modal-body">${body}</div></section></div>`;setTimeout(()=>document.querySelector('.modal input,.modal select,.modal textarea,.modal button')?.focus(),20);}
function closeModal(){modalName=null;document.getElementById('modal-root').innerHTML='';}
window.addEventListener('popstate',()=>{window.Vektor.ownerLoginEmployeeId=null;state.page=location.hash.slice(1)||DEFAULT.page;render();});
window.Vektor={state,h,PAGES,NAV,STATUS,ROLELABEL,DEFAULT,current,save,render,navigate,selectTask,storeEvidence,toast,showModal,closeModal,navItem,reset(){state=structuredClone(DEFAULT);window.Vektor.state=state;history.replaceState(null,'','#'+DEFAULT.page);render();}};
document.addEventListener('DOMContentLoaded', () => render(), {once: true});
})();
