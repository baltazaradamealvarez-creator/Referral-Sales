'use strict';

// A small, real text PDF so tests exercise decoding as well as field extraction.
function pdf(lines) {
  const escape=s=>String(s).replace(/([\\()])/g,'\\$1');
  const stream='BT /F1 11 Tf 45 750 Td 16 TL\n'+lines.map((s,i)=>(i?'T* ':'')+'('+escape(s)+') Tj').join('\n')+'\nET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body='%PDF-1.4\n',offsets=[0];
  objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(body);
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const orderLines=(name='Maria Lopez',extras=[])=>['Spectrum Order Confirmation','Account Number: 123456789012',
  'Order Number: ABC12345','Customer Name: '+name,'Phone: (512) 867-5309',
  'Service Address: 1010 Ogden Ave','Dallas, TX 75211','Installation Date: 10/15/2026',
  'Services: Internet, TV','Package: Internet + TV','Monthly Total: $80.00',...extras];
// Sanitized version of Spectrum's printed checkout layout. All customer and
// account identifiers are fictional; the customer's block has no field labels.
const spectrumLines=()=>['Spectrum Order Confirmation','Thanks for the order',
  'Email: maria.lopez@gmail.com','Monthly Payment','$70.00','Delivery Date','10/6/26',
  'Initial Payment','$90.00','Reference Number','2150000210','Order Support: 1.855.392.9910',
  'MONTHLY HOME SERVICES','Internet','Spectrum Internet 1 Gig','Advanced WiFi Included',
  'ONE-TIME CHARGES','Service Activation $20.00','Express Connect Kit Included',
  'MONTHLY MOBILE SERVICES','Applicable only if Mobile Unlimited line is activated within 30 days of order',
  '1 Unlimited Line Included','Est. Monthly Home Services $70.00','Est. Monthly Mobile Services $0.00',
  'Est. Monthly Total','$70.00','Est. Initial Payment','$90.00','ACCOUNT DETAIL S',
  'Account Number','8280000000004739','Work Order Number','1000000000004030',
  'Contact Information','Maria Lopez','1010 Ogden Ave','Dallas, TX 75211','5128675309',
  'Billing Information','Maria Lopez','1010 Ogden Ave','Dallas, TX 75211'];
module.exports={pdf,orderLines,spectrumLines};
