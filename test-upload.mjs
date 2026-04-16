import fs from 'fs';

async function testUpload() {
  const formData = new FormData();
  
  // Use the sample PDF provided in the project
  const fileBuffer = fs.readFileSync('./test/data/05-versions-space.pdf');
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  formData.append('file', blob, '05-versions-space.pdf');

  try {
    const res = await fetch('http://localhost:3001/api/upload?sessionId=123e4567-e89b-12d3-a456-426614174000', {
      method: 'POST',
      body: formData
    });
    
    console.log('Status:', res.status);
    console.log('Body:', await res.text());
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

testUpload();
