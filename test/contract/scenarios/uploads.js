/**
 * File uploads, with storage replaced by the test server's in-memory stand-ins (nothing leaves the machine):
 *  - the business logo (replace, remove, size and type rules);
 *  - driver and vehicle documents (submit, replace, signed link, review, history, verification status);
 *  - the older image upload / delete endpoints.
 * The files are tiny fakes with the right first bytes: the server decides a file's type from those bytes.
 */
const { configuredBusiness } = require('./common');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const TEXT = Buffer.from('this is not an image or a pdf, just text');
const BIG = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10, 3)]); // over the 1 MB logo limit

const file = (data, name, type) => ({ field: 'file', name, type, data });

module.exports = async function uploads(t) {
  const { call } = t;
  const ctx = await configuredBusiness(t);
  const { admin, H, driverId, vehicleId } = ctx;
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });

  // ---- the business logo
  await call('logo: no session', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(PNG, 'logo.png', 'image/png') }, headers: H, expectStatus: 401 });
  await biz('logo: no file', { method: 'POST', path: '/api/admin/business/logo', form: { fields: {} } });
  await biz('logo: not an image', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(TEXT, 'logo.txt', 'image/png') } });
  await biz('logo: a PDF is not a logo', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(PDF, 'logo.pdf', 'application/pdf') } });
  await biz('logo: too large', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(BIG, 'big.png', 'image/png') } });
  await biz('logo: upload', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(PNG, 'logo.png', 'image/png') }, expectStatus: 200 });
  await biz('logo: the business shows it', { path: '/api/admin/business' });
  await biz('logo: replace', { method: 'POST', path: '/api/admin/business/logo', form: { file: file(JPEG, 'logo.jpg', 'image/jpeg') }, expectStatus: 200 });
  await biz('logo: the business shows the new one', { path: '/api/admin/business' });
  await biz('logo: remove', { method: 'DELETE', path: '/api/admin/business/logo', expectStatus: 200 });
  await biz('logo: the business after removal', { path: '/api/admin/business' });
  await biz('logo: audit', { path: '/api/admin/business/audit' });

  // ---- driver documents
  const reqs = (await biz('requirements: what is needed', { path: '/api/admin/business/requirements', expectStatus: 200 })).body.data;
  const driverTypes = reqs.driver;
  const need = (list, type) => list.find((r) => r.type === type);
  const dl = need(driverTypes, 'DRIVING_LICENCE');
  const identity = need(driverTypes, 'IDENTITY');
  const dBase = `/api/admin/business/drivers/${driverId}/documents`;
  await biz('driver documents: list (none yet)', { path: dBase, expectStatus: 200 });
  await biz('driver documents: unknown driver', { method: 'POST', path: '/api/admin/business/drivers/drv_missing/documents', form: { fields: { type: 'IDENTITY' }, file: file(PDF, 'id.pdf', 'application/pdf') } });
  await biz('driver documents: unknown type', { method: 'POST', path: dBase, form: { fields: { type: 'NOPE' }, file: file(PDF, 'x.pdf', 'application/pdf') } });
  await biz('driver documents: no file', { method: 'POST', path: dBase, form: { fields: { type: 'DRIVING_LICENCE', number: 'MH12 2020 1234567', expiryDate: '2030-01-01' } } });
  await biz('driver documents: not a document type', { method: 'POST', path: dBase, form: { fields: { type: 'DRIVING_LICENCE', number: 'MH12 2020 1234567', expiryDate: '2030-01-01' }, file: file(TEXT, 'dl.txt', 'application/pdf') } });
  await biz('driver documents: licence needs a number', { method: 'POST', path: dBase, form: { fields: { type: 'DRIVING_LICENCE', expiryDate: '2030-01-01' }, file: file(PDF, 'dl.pdf', 'application/pdf') } });
  await biz('driver documents: licence needs a valid expiry', { method: 'POST', path: dBase, form: { fields: { type: 'DRIVING_LICENCE', number: 'MH12 2020 1234567', expiryDate: 'not a date' }, file: file(PDF, 'dl.pdf', 'application/pdf') } });
  const dlDoc = await biz('driver documents: submit the licence', { method: 'POST', path: dBase, form: { fields: { type: 'DRIVING_LICENCE', number: 'MH12 2020 1234567', expiryDate: '2030-01-01' }, file: file(PDF, '../../licence front.pdf', 'application/pdf') }, expectStatus: 201 });
  const dlId = dlDoc.body.data.document.id || dlDoc.body.data.document.docId;
  await biz('driver documents: a photo must be an image', { method: 'POST', path: dBase, form: { fields: { type: 'PROFILE_PHOTO' }, file: file(PDF, 'me.pdf', 'application/pdf') } });
  await biz('driver documents: submit a profile photo', { method: 'POST', path: dBase, form: { fields: { type: 'PROFILE_PHOTO' }, file: file(PNG, 'me.png', 'image/png') }, expectStatus: 201 });
  const idDoc = await biz('driver documents: submit the identity document', { method: 'POST', path: dBase, form: { fields: { type: 'IDENTITY', number: 'ABCDE1234F' }, file: file(JPEG, 'id.jpg', 'image/jpeg') }, expectStatus: 201 });
  const idId = idDoc.body.data.document.id || idDoc.body.data.document.docId;
  await biz('driver documents: list', { path: dBase, expectStatus: 200 });
  await biz('driver documents: signed link', { path: `/api/admin/business/driver-documents/${dlId}/url`, expectStatus: 200 });
  await biz('driver documents: link to an unknown document', { path: '/api/admin/business/driver-documents/doc_missing/url' });
  await biz('driver documents: review, nothing chosen', { method: 'POST', path: `/api/admin/business/driver-documents/${dlId}/review`, body: {}, expectStatus: 400 });
  await biz('driver documents: reject needs a reason', { method: 'POST', path: `/api/admin/business/driver-documents/${idId}/review`, body: { decision: 'REJECT' }, expectStatus: 400 });
  await biz('driver documents: approve the licence', { method: 'POST', path: `/api/admin/business/driver-documents/${dlId}/review`, body: { decision: 'APPROVE' } });
  await biz('driver documents: approve again', { method: 'POST', path: `/api/admin/business/driver-documents/${dlId}/review`, body: { decision: 'APPROVE' } });
  await biz('driver documents: reject the identity document', { method: 'POST', path: `/api/admin/business/driver-documents/${idId}/review`, body: { decision: 'REJECT', reason: 'The photo is too blurry to read' } });
  await biz('driver documents: review a rejected one', { method: 'POST', path: `/api/admin/business/driver-documents/${idId}/review`, body: { decision: 'APPROVE' } });
  await biz('driver documents: resubmit the identity document', { method: 'POST', path: dBase, form: { fields: { type: 'IDENTITY', number: 'ABCDE1234F' }, file: file(PNG, 'id-clear.png', 'image/png') }, expectStatus: 200 });
  await biz('driver documents: approve the identity document', { method: 'POST', path: `/api/admin/business/driver-documents/${idId}/review`, body: { decision: 'APPROVE' } });
  await biz('driver documents: list after review', { path: dBase });
  await biz('driver: the record after documents', { path: `/api/admin/business/drivers/${driverId}` });
  await biz('driver: history', { path: `/api/admin/business/drivers/${driverId}/history` });
  await biz('driver documents: revoke an approval', { method: 'POST', path: `/api/admin/business/driver-documents/${dlId}/review`, body: { decision: 'REJECT', reason: 'Licence number does not match the card' } });
  await biz('driver: the record after the revocation', { path: `/api/admin/business/drivers/${driverId}` });

  // ---- vehicle documents
  const vehicleTypes = reqs.vehicle;
  const vdoc = vehicleTypes.find((r) => !r.photo && r.needsNumber && r.needsExpiry) || vehicleTypes.find((r) => !r.photo);
  const vBase = `/api/admin/business/vehicles/${vehicleId}/documents`;
  await biz('vehicle documents: list', { path: vBase, expectStatus: 200 });
  await biz('vehicle documents: unknown vehicle', { method: 'POST', path: '/api/admin/business/vehicles/veh_missing/documents', form: { fields: { type: vdoc.type }, file: file(PDF, 'v.pdf', 'application/pdf') } });
  const fields = { type: vdoc.type, ...(vdoc.needsNumber ? { number: 'MH12AB1234' } : {}), ...(vdoc.needsExpiry ? { expiryDate: '2030-06-30' } : {}) };
  const vDoc = await biz('vehicle documents: submit', { method: 'POST', path: vBase, form: { fields, file: file(PDF, 'vehicle.pdf', 'application/pdf') }, expectStatus: 201 });
  const vId = vDoc.body.data.document.id || vDoc.body.data.document.docId;
  await biz('vehicle documents: an expired one is refused', { method: 'POST', path: vBase, form: { fields: { ...fields, expiryDate: '2020-01-01' }, file: file(PDF, 'vehicle.pdf', 'application/pdf') } });
  await biz('vehicle documents: signed link', { path: `/api/admin/business/vehicle-documents/${vId}/url`, expectStatus: 200 });
  await biz('vehicle documents: approve', { method: 'POST', path: `/api/admin/business/vehicle-documents/${vId}/review`, body: { decision: 'APPROVE' } });
  await biz('vehicle documents: list after review', { path: vBase });
  await biz('vehicle: the record after documents', { path: `/api/admin/business/vehicles/${vehicleId}` });
  await biz('vehicle: history', { path: `/api/admin/business/vehicles/${vehicleId}/history` });
  await biz('audit: documents', { path: '/api/admin/business/audit' });
  await biz('eligibility after documents', { path: '/api/admin/business/availability' });

  // ---- the older image endpoints
  await call('images: upload without a file', { method: 'POST', path: '/api/images/upload', form: { fields: {} } });
  await call('images: upload a text file', { method: 'POST', path: '/api/images/upload', form: { file: { field: 'image', name: 'a.txt', type: 'text/plain', data: TEXT } } });
  await call('images: upload', { method: 'POST', path: '/api/images/upload', form: { fields: { folder: 'contract-folder' }, file: { field: 'image', name: 'a.png', type: 'image/png', data: PNG } } });
  await call('images: upload, default folder', { method: 'POST', path: '/api/images/upload', form: { file: { field: 'image', name: 'b.png', type: 'image/png', data: PNG } } });
  await call('images: delete', { method: 'DELETE', path: `/api/images/delete/${encodeURIComponent('contract-folder/image-1')}` });
  await call('images: delete one that is not there', { method: 'DELETE', path: '/api/images/delete/missing' });
};
