/**
 * The public "how to delete your account" page (rider and driver apps), served at /account-deletion. Google Play asks every app that lets people
 * create an account for a web address that explains how to ask for deletion without opening the app; this is it.
 * Plain static HTML: no scripts, no data from the visitor.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#15803D">
<title>Delete your account</title>
<style>
:root{--g:#15803D;--ink:#0F172A;--mut:#475569;--line:#E5E7EB;--bg:#F6F8F7;--card:#fff;--tint:#F0FAF3;--red:#B91C1C}
@media (prefers-color-scheme: dark){:root{--ink:#F1F5F9;--mut:#A8B3C5;--line:#273244;--bg:#0B1220;--card:#111A2C;--tint:#12301F;--red:#F87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 16px 56px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 8px}
p,li{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:14px 0}
.tint{background:var(--tint);border-color:transparent}
ol,ul{padding-left:22px;margin:8px 0}
li{margin:6px 0}
b{color:var(--ink)}
.red{color:var(--red)}
small{color:var(--mut)}
</style>
</head>
<body>
<main>
<h1>Delete your account</h1>
<p>This page applies to the rider app and the driver app. You can delete your account and personal data at any time, from the app or by asking the support team of the service you ride or drive with.</p>

<div class="card tint">
<h2 style="margin-top:0">In the rider app (fastest)</h2>
<ol>
<li>Open the app and sign in.</li>
<li>Go to <b>Profile</b> and tap <b>Delete account</b> (you can also reach it under <b>Privacy &amp; data</b>).</li>
<li>Read what will be deleted, then confirm with <b>Delete my account</b>.</li>
</ol>
<h2>In the driver app</h2>
<ol>
<li>Open the app and sign in.</li>
<li>Go to <b>Profile &rarr; Privacy &amp; Data</b> and tap <b>Delete driver account</b>.</li>
<li>Read what will be deleted, type <b>DELETE</b> and confirm. You can first use <b>Download my data</b> on the same screen to keep a copy.</li>
</ol>
<p>Deletion happens immediately. You are signed out and the account cannot be recovered.</p>
</div>

<div class="card">
<h2 style="margin-top:0">If you cannot open the app</h2>
<p>Contact the support team of the service you ride with (the phone number and email are on the app's store page and in the app under <b>Profile &rarr; Help &amp; support</b>). Write from the email address or call from the phone number on the account, and ask for the account to be deleted. We will confirm by the same route, normally within 7 days.</p>
</div>

<h2>What is deleted</h2>
<ul>
<li>Your name, phone number, email address and profile photo.</li>
<li><b>Drivers:</b> your licence, ID, bank and vehicle details, every document you uploaded (and its stored file), your support reports and your online-hours log. Your vehicle is released back to the business.</li>
<li>Your sign-in session, device and notification identifiers.</li>
<li>Your notifications and any pending verification codes.</li>
<li>Addresses saved on your phone (Home, Work, recent places) are removed from the device.</li>
</ul>

<h2>What is kept, and why</h2>
<ul>
<li><b>Finished trips</b> (date, route, distance, fare, payment mode) are kept as business and accounting records, and so earnings stay correct. After deletion nothing in the account names you.</li>
<li><b>Support conversations and safety reports</b> about a trip may be kept for fraud prevention, safety and legal obligations.</li>
<li>Records the law requires us to keep are kept for the period the law sets, then removed.</li>
</ul>

<h2>Before you delete</h2>
<ul>
<li>You cannot delete the account while a ride is in progress. Finish or cancel it first (drivers: finish or cancel the current ride).</li>
<li>Any cancellation charge you still owe is not removed by deleting the account.</li>
<li>You can use the same phone number to create a new account later; it will start empty.</li>
</ul>

<p><small>Rider app: location is used only while the app is open, to set your pickup point, show nearby drivers and follow your trip. Driver app: location is used while you are online and during a trip, including when the app is in the background, so riders can be matched with you and follow their pickup; it stops when you go offline. See the privacy policy in the app under <b>Profile &rarr; Privacy &amp; data</b>.</small></p>
</main>
</body>
</html>`;

module.exports = { PAGE };
