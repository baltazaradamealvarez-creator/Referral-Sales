'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractText,parseOrder,orderPatch,MAX_BYTES}=require('../src/whatsapp-order-pdf');
const {pdf,orderLines,spectrumLines}=require('./fixtures/order-pdf');
const {detectStatus}=require('../src/dispatch-bot');

test('local PDF reader extracts an actual order, account, installation, services and monthly value',async()=>{
  const text=await extractText(pdf(orderLines()));
  const result=parseOrder(text);
  assert.equal(result.issue,'');
  assert.equal(result.fields.account_number,'123456789012');
  assert.equal(result.fields.order_number,'ABC12345');
  assert.equal(result.fields.name,'Maria Lopez');
  assert.equal(result.fields.phone,'5128675309');
  assert.equal(result.fields.install_date,'2026-10-15');
  assert.equal(result.fields.city,'Dallas');assert.equal(result.fields.state,'TX');assert.equal(result.fields.zip,'75211');
  assert.equal(result.fields.est_monthly_value,80);assert.equal(result.fields.services,'Internet, TV');
  const splitAddress=parseOrder(orderLines('Maria Lopez',['City: Dallas','State: Texas','ZIP Code: 75211']).map(x=>x.replace('Account Number:','Account:')).join('\n'));
  assert.equal(splitAddress.fields.state,'TX');assert.equal(splitAddress.fields.account_number,'123456789012');
});
test('PDF parsing refuses guesses, masked accounts, conflicting accounts, quotes and bills',()=>{
  for(const lines of [orderLines('Maria Lopez',['Account Number: 999999999999']),
    orderLines().map(x=>x.replace('123456789012','XXXX789012')),
    orderLines().filter(x=>!x.startsWith('Account')),
    orderLines('Maria Lopez',['Balance due: $100']),orderLines('Maria Lopez',['Quote only']),
    orderLines('Maria Lopez',['Order cancelled'])])assert.ok(parseOrder(lines.join('\n')).issue);
  assert.match(parseOrder('').issue,/Scanned PDFs/);
  const missingDate=parseOrder(orderLines().map(x=>x.replace('10/15/2026','02/30/2026')).join('\n'));
  assert.equal(missingDate.fields.install_date,undefined);
});
test('Spectrum checkout uses the customer contact block, separate delivery and initial payment, and conditional mobile offer',async()=>{
  const result=parseOrder(await extractText(pdf(spectrumLines())));
  assert.equal(result.issue,'');
  assert.deepEqual(result.fields,{
    account_number:'8280000000004739',order_number:'1000000000004030',order_reference:'2150000210',
    email:'maria.lopez@gmail.com',est_monthly_value:70,initial_payment:90,delivery_date:'2026-10-06',
    name:'Maria Lopez',phone:'5128675309',address:'1010 Ogden Ave, Dallas, TX 75211',
    city:'Dallas',state:'TX',zip:'75211',mobile_activation_pending:true,mobile_offer:'1 Unlimited Line',
    services:'Internet',package_details:'Spectrum Internet 1 Gig; Advanced WiFi included',
  });
  const patch=orderPatch(result.fields,{customer_name:'Maria Lopez',phone:'5128675309',status:'Passed'});
  assert.equal(patch.body.install_date,undefined,'a delivery date is not an installation date');
  assert.equal(patch.body.order_number,'1000000000004030');assert.equal(patch.body.initial_payment,90);
  assert.equal(patch.body.services,'Internet','the mobile offer has not been activated');
});
test('PDF reader rejects corrupt or oversized files and order patches preserve existing customer data',async()=>{
  await assert.rejects(extractText(Buffer.from('not a PDF')),/valid PDF/);
  await assert.rejects(extractText(Buffer.alloc(MAX_BYTES+1)),/5 MB/);
  await assert.rejects(extractText(Buffer.from('%PDF-1.4\ncorrupt')),/could not be read/);
  const fields=parseOrder(orderLines().join('\n')).fields;
  const ref={customer_name:'Maria Lopez',phone:'5128675309',status:'Working',services:'Internet',city:'Dallas'};
  const result=orderPatch(fields,ref);
  assert.equal(result.body.status,'Ordered');assert.equal(result.body.phone,undefined);assert.equal(result.body.services,undefined);
  assert.equal(result.body.city,undefined);assert.equal(result.body.zip,'75211');
  assert.match(orderPatch(fields,{...ref,phone:'5125550199'}).issue,/conflict/);
  assert.match(orderPatch(fields,{...ref,account_number:'9999999999'}).issue,/conflict/);
  assert.match(orderPatch(fields,{...ref,status:'Cancelled'}).issue,/closed/);
});
test('common dispatch phrases describe stages without guessing questions, future actions or other confirmations',()=>{
  for(const phrase of ['on it',"I'm on it",'On it, calling now','on it, will call now','working on it'])assert.equal(detectStatus(phrase).status,'Working');
  for(const phrase of ['confirmed','Confirmed customer','Confirmed. Will upload PDF','confirmado','confirmada'])assert.equal(detectStatus(phrase).status,'Passed');
  assert.equal(detectStatus('order confirmed').status,'Ordered');
  assert.equal(detectStatus('not qualified').status,'DNQ');
  assert.deepEqual(detectStatus('not order confirmed yet'),{});
  for(const phrase of ['not on it','not working on it yet','not confirmed yet','is it confirmed?',
    'will be confirmed tomorrow','appointment confirmed','address confirmed','waiting for account to be confirmed'])
    assert.deepEqual(detectStatus(phrase),{},phrase);
});

test('PDF matching accepts saved alternate phones and normalized formatting, and explains actual differences',()=>{
  const {customerConflicts}=require('../src/whatsapp-order-pdf');
  const fields=parseOrder(orderLines().join('\n')).fields;
  const ref={customer_name:'MARIA LOPEZ',phone:'5125550142',alt_phone:'+1 (512) 867-5309',address:'1010 Ogden Avenue, Dallas TX 75211-1234',status:'Working'};
  assert.deepEqual(customerConflicts(fields,ref),[]);assert.equal(orderPatch(fields,ref).body.status,'Ordered');
  const changed={...fields,email:'new@gmail.com',address:'1011 Ogden Ave, Dallas TX 75211'};
  const conflicts=customerConflicts(changed,{...ref,email:'old@gmail.com'});
  assert.deepEqual(conflicts.map(c=>c.key),['email','address']);assert.equal(conflicts[0].incoming,'new@gmail.com');
  assert.match(orderPatch(changed,{...ref,email:'old@gmail.com'}).issue,/email, address/);
});
