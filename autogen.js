
var kToday = (new Date).toISOString();

module.exports = [

{project:'#autogen.01000', list:[

{type:'project', oid:'#autogen.01000', autogen:'yep', data:{ name:'About Suae', created:kToday }},

{type:'page', oid:'#autogen.01010',
data:{ name:' Splash', added:kToday },
layout:[ {class:'htmlEdit', style:'left:-1px; top:-1px; width:100%; height:2500px;', pid:'#autogen.01011', oid:'#autogen.01012'} ]
},

{type:'part', oid:'#autogen.01012', data:'\
<div class="logo" style="position:absolute; top:300px; left:200px; font-size:8em;">\
  <span class="logos">s</span><span class="logou">u</span><span class="logoa">a</span><span class="logoe">e</span></div>\
<div style="position:absolute; top:200px; left:700px; width:300px; height:400px; padding:10px; background:#eee; color:#444; font: 1em verdana;">\
  <p>If you haven\'t reviewed the App Mockup on the suae website, do. It\'ll give you a much\
  clearer picture of what suae\'s about.</p>\
  <p>The current version of suae has a modest feature set, which you can walk through in this\
  <a href="suae:#about.3" onclick="suae.pMgr.goPage(suae.hrefOid(this.href)); return false;">tutorial</a>.</p>\
  <p>See also the <a href="suae:#about.2" onclick="suae.pMgr.goPage(suae.hrefOid(this.href)); return false;">introduction</a>.</p>\
  </div>'
},

{type:'page', oid:'#autogen.01020',
data:{ name:'Introduction', added:kToday },
layout:[ {class:'htmlEdit', style:'left:-1px; top:-1px; width:100%; height:2500px;', pid:'#autogen.01021', oid:'#autogen.01022'} ]
},

{type:'part', oid:'#autogen.01022', data:'\
<div style="position:absolute; top:100px; left:50px; width:400px; font: 90% verdana;">\
  Introduction to <span style="font-style:italic; font-weight:bold;">suae</span>...\
\
  <p>suae is an open source app/environment for composing and sharing digital documents, which are structured as webs &#x2014;\
  groups of interlinked pages, or "projects". Project pages are composed of "parts", which are edited via palettes\
  (instead of toolbars and dialogs).</p>\
\
  <p>Sharing and sync of a project among a group of users. Offline operation. suae servers relay user data, but do not store it.\
  Auto-backup to a second local drive or backup service. Plug-in part editors, provided via suae server.</p>\
\
  <p>suae provides a lightweight framework for developing content editors. (We\'re counting on users to contribute\
  a lot in this department; a good content editor is a lot of work!) In its initial release, suae includes an\
  example content editor, for creating palettes, and some rudimentary editors for text and images.</p>\
\
  <p>Technology foundation: suae currently runs on Firefox 3.5, and syncs via ejabberd. Besides Javascript &amp;\
  HTML/CSS, it leverages these technologies: Javascript E4X, DOM localStorage, XMPP pubsub. Eventually suae will be\
  a Mozilla Prism app.</p>\
</div>\
\
<div style="position:absolute; top:100px; left:500px; width:400px; font: 90% verdana;">\
  <b>suae 0.0 features...</b>\
\
  <p style="line-height:150%;">\
  Project <u>add</u>, edit, remove, export, <u>import</u><br/>\
  Page <u>add</u>, edit, <u>scroll</u>, remove<br/>\
  Part <u>add</u>, remove<br/>\
  Service <u>manager</u><br/>\
  User profile view, edit, update<br/>\
  Project member <u>add</u>, view, remove<br/>\
  Project invites <u>receive</u>, <u>view</u>, <u>accept</u><br/>\
  Project updates <u>send</u>, <u>receive</u><br/>\
  Project state <u>add</u>, <u>edit</u>, remove<br/>\
  Rev history <u>without diff</u><br/>\
  Edit <u>palette</u>, <u>html</u><br/>\
  Editors <u>load dynamically</u><br/>\
  Storage <u>via browser</u>, <u>auto-save</u><br/>\
  Menu <u>bar</u>, <u>palettes</u><br/>\
  Project bar <u>sorts</u>, hide, widgets<br/>\
  Palettes <u>definition</u>, <u>widgets</u><br/>\
  </p>\
\
  <b>suae 0.1 features planned</b>\
  <p style="line-height:150%">\
  Screen split<br/>\
  Auto-release unused views, data, code<br/>\
  Edit text, image, svg, note<br/>\
  </p>\
  </div>'
},

{type:'page', oid:'#autogen.01030',
data:{ name:'Tutorial', added:kToday },
layout: [
 {class:'htmlEdit', style:'left:-1px; top:-1px; width:100%; height:2500px;', pid:'#autogen.01031', oid:'#autogen.01032'},
 {class:'htmlEdit', style:'left:50px; top:1100px; width:250px; height:250px;', pid:'#autogen.01033', oid:'#autogen.01034'},
 {class:'myEdit', style:'left:50px; top:1400px; width:250px; height:250px;', pid:'#autogen.01035', oid:'#autogen.01036'},
 {class:'paletteEdit', style:'left:50px; top:1700px; width:250px; height:250px;', pid:'#autogen.01037', oid:'#autogen.01038'}]
},

{type:'part', oid:'#autogen.01032', data:'\
<div style="position:absolute; top:320px; right:250px; width:300px; font: 90% verdana;">\
<b>The Projects Bar =></b>\
<p>Projects can be sorted in different ways via the sort menu; the default sort is "named".</p>\
<p>You\'re currently in the About Suae project. The Projects project contains one page listing invitations to other projects.\
   The User Profiles project contains a page for making connections to relay services, as well as profiles for\
   you and the active members of projects in circulation.</p>\
<p>To create a new Project, click the "new" button.</p>\
</div>\
<div style="position:absolute; top:15px; right:250px; width:350px; font: 90% verdana;">\
<b>The Menu Bar =></b>\
<p>Mouse-over a menu to show it.</p>\
<p style="line-height:150%">Its menus:<br/>\
Tools - a list of part editors<br/>\
Layout - page controls<br/>\
Pages - the pages in the current project<br/>\
Circulation - the members of the current project<br/>\
Project - project controls<br/>\
Help - docs, forums, news<br/>\
suae - app controls and settings</p>\
</div>\
<div style="position:absolute; top:300px; left:25px; width:250px; font: 90% verdana;">\
<b>&lt;= The Scroll Bar</b>\
<p>It\'s on the left side to be next to the content it refers to.</p>\
</div>\
<div style="position:absolute; top:50px; left:200px; width:350px; font: 90% verdana;">\
<b>Auto-Save &amp; App State</b>\
<p>suae automatically saves all user edits to local (client-side) storage. It doesn\'t store data online.</p>\
<p>suae preserves the state of the application (current project, page, etc) so that if the browser is closed or the suae page\
is reloaded, the app will come back precisely where it left off.</p>\
</div>\
<div style="position:absolute; top:500px; left:50px; width:350px; font: 90% verdana;">\
<b>Continue Tutorial...</b>\
<p>Scroll down to continue.</p>\
</div>\
<div style="position:absolute; top:1130px; left:350px; width:350px; font: 90% verdana;">\
<b>Page Parts</b>\
<p>Parts are page elements, of any data type, which are viewed and edited via part editors.</p>\
<p>suae currently has three part editors, the most sophisticated of which is for editing\
palettes.</p>\
<p>Each part editor has an associated editing palette; click the part to bring it up.</p>\
<p>These text blurbs are part of a single HTML part which lies behind the parts at left.</p>\
</div>\
<div style="position:absolute; top:1250px; right:250px; width:300px; font: 90% verdana;">\
<b>Create a Project</b>\
<p>To create a new project, click "new" on the project bar. A tutorial will appear in the new project\'s message palette.</p>\
</div>'
},

{type:'part', oid:'#autogen.01034', data:'\
This is an <a href="http://w3c.org/">HTML</a> part.'
},

{type:'part', oid:'#autogen.01036', data:' '},

{type:'part', oid:'#autogen.01038', data:'\
<size w="250px" h="250px"/>\
<label name="0" style="left:10px; top:10px;">This a palette part.</label>\
<label name="1" style="left:10px; top:40px;">The palette definition generated by this editor can be plugged into part editor code.</label>'
}

]}

];


