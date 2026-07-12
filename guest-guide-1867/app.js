(() => {
 const guide=window.GUEST_GUIDE, updates=window.GUEST_UPDATES||{}, owner=new URLSearchParams(location.search).get('edit')==='1';
 const grid=document.querySelector('#category-grid'), panels=document.querySelector('#category-panels');
 document.querySelector('#welcome-line').textContent=guide.site.welcome;
 document.querySelector('.hero').style.backgroundImage=`linear-gradient(rgba(248,247,243,.80),rgba(248,247,243,.94)),url('${guide.site.heroImage}')`;
 if(owner){document.body.classList.add('owner-preview');document.querySelector('#editor-notice').hidden=false;}
 const paths={spark:'<path d="m12 3 1.6 5.3L19 10l-5.4 1.7L12 17l-1.6-5.3L5 10l5.4-1.7L12 3Z"/>',home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V21h13V10.5"/><path d="M9 21v-6h6v6"/>',leaf:'<path d="M20 4C11 4 5 9 5 17c5 0 10-2 13-7"/><path d="M4 21c3-6 7-9 13-12"/>',check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',pin:'<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>'};
 const icon=n=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths[n]}</svg>`;
 function localISODate(){
   const now=new Date();
   const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
   return `${y}-${m}-${d}`;
 }
 function ordinal(n){
   const mod100=n%100;
   if(mod100>=11&&mod100<=13)return `${n}th`;
   return `${n}${n%10===1?'st':n%10===2?'nd':n%10===3?'rd':'th'}`;
 }
 function displayDate(iso){
   const d=new Date(`${iso}T12:00:00`);
   if(Number.isNaN(d.getTime()))return iso;
   return `${d.toLocaleDateString('en-GB',{weekday:'long'})} ${ordinal(d.getDate())} ${d.toLocaleDateString('en-GB',{month:'long'})}`;
 }
 function validCollection(row){
   return row&&/^\d{4}-\d{2}-\d{2}$/.test(String(row.date||''))&&Array.isArray(row.collections)&&row.collections.some(x=>String(x||'').trim());
 }
 function binSchedule(){
   const bins=updates.bins||{}, rows=Array.isArray(bins.collections)?bins.collections:[];
   const today=localISODate();
   const valid=rows.filter(validCollection).sort((a,b)=>a.date.localeCompare(b.date));
   const upcoming=valid.filter(row=>row.date>=today);
   const invalid=rows.filter(row=>!validCollection(row));
   if(!upcoming.length&&!owner)return '<p class="no-bin-dates">Please check with the property managers for the next collection date.</p>';
   let html='';
   if(upcoming.length){
     const next=upcoming[0];
     html+=`<section class="next-collection"><span class="eyebrow">Next collection</span><h3>${displayDate(next.date)}</h3><ul>${next.collections.map(x=>`<li>${x}</li>`).join('')}</ul></section>`;
     html+='<section class="collection-schedule"><h3>Upcoming collection dates</h3>';
     html+=upcoming.map(row=>`<div class="collection-date"><strong>${displayDate(row.date)}</strong><ul>${row.collections.map(x=>`<li>${x}</li>`).join('')}</ul></div>`).join('');
     html+='</section>';
   }
   if(owner){
     const threshold=Number(bins.warningWhenFewerThan)||4;
     if(upcoming.length<threshold){
       html+=`<aside class="schedule-warning"><strong>Schedule running low</strong><br>Only ${upcoming.length} future collection date${upcoming.length===1?' remains':'s remain'}. Add more dates in <code>frequent-updates.js</code>.</aside>`;
     }
     if(invalid.length){
       html+=`<aside class="schedule-warning"><strong>${invalid.length} incomplete collection entr${invalid.length===1?'y':'ies'}</strong><br>Check the date and collection list in <code>frequent-updates.js</code>.</aside>`;
     }
   }
   if(bins.lastUpdated)html+=`<p class="last-updated">Last updated: ${bins.lastUpdated}</p>`;
   return html;
 }
 function md(s,checklist=false){
   const token='__BIN_COLLECTION_DATES__';
   let x=s.replace('[BIN_COLLECTION_DATES]',token).trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
   x=x.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/_([^_]+)_/g,'<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>');
   const lines=x.split(/\n/), out=[]; let inList=false;
   for(const line of lines){
     if(/^[-] /.test(line)){if(!inList){out.push(`<ul class="${checklist?'checklist':''}">`);inList=true;} out.push(`<li>${line.slice(2)}</li>`)}
     else {if(inList){out.push('</ul>');inList=false;} if(line.trim()==='') out.push(''); else out.push(`<p>${line.replace(/  $/,'<br>')}</p>`)}
   }
   if(inList)out.push('</ul>');
   return out.join('').replace(token,binSchedule()).replace(/\[TO COMPLETE(?::[^\]]+)?\]/g,m=>`<mark class="todo">${m}</mark>`);
 }
 guide.categories.forEach(cat=>{
   const visible=cat.items.filter(x=>x.complete||owner);
   const card=document.createElement('a'); card.href=`#${cat.id}`;card.className='category-card';card.innerHTML=`${icon(cat.icon)}<span>${cat.title}</span><b>+</b>`;grid.append(card);
   const panel=document.createElement('section');panel.id=cat.id;panel.className='category-panel';
   panel.innerHTML=`<div class="category-heading"><h2>${cat.title}</h2></div><div class="item-list"></div>`;
   const list=panel.querySelector('.item-list');
   visible.forEach(item=>{const d=document.createElement('details');d.className=`guide-item${item.complete?'':' incomplete'}`;d.innerHTML=`<summary><span>${item.title}</span><b>+</b></summary><div class="item-content">${md(item.content,item.checklist)}</div>`;d.addEventListener('toggle',()=>d.querySelector('summary b').textContent=d.open?'−':'+');list.append(d)});
   if(!visible.length) panel.classList.add('empty');
   panels.append(panel);
 });
 document.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(!a)return;const t=document.querySelector(a.getAttribute('href'));if(t)t.scrollIntoView({behavior:'smooth',block:'start'});});
})();
