const jwt = require('../../backend/node_modules/jsonwebtoken');
require('../../backend/src/env');

const JWT_SECRET = process.env.JWT_SECRET || 'vas-revenue-tracker-secret-key-2026';

const token = jwt.sign(
  { id: 1, username: 'vasadmin', role_id: 1, role_name: 'Super Admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function testChatFlow() {
  console.log('Testing Chat Message Send, Fetch, and Read flow...\n');

  // 1. Fetch messages between user 1 and user 6
  console.log('1. Fetching messages between 1 and 6...');
  const res1 = await fetch('http://localhost:5000/api/chat/messages?user_id=1&other_user_id=6', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data1 = await res1.json();
  if (!res1.ok) {
    console.error('❌ Fetch messages failed:', data1);
    process.exit(1);
  }
  console.log(`✅ Messages fetched: count = ${data1.length}`);

  // 2. Send a test message
  console.log('\n2. Sending direct message from 1 to 6...');
  const res2 = await fetch('http://localhost:5000/api/chat/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_id: 1,
      receiver_id: 6,
      message_text: 'Test message for PostgreSQL verification',
    }),
  });
  const data2 = await res2.json();
  if (!res2.ok) {
    console.error('❌ Send message failed:', data2);
    process.exit(1);
  }
  console.log('✅ Send message SUCCESS! Message ID:', data2.id, 'Text:', data2.message_text);

  // 3. Mark as read / re-fetch
  console.log('\n3. Re-fetching messages (triggers mark as read)...');
  const res3 = await fetch('http://localhost:5000/api/chat/messages?user_id=6&other_user_id=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data3 = await res3.json();
  if (!res3.ok) {
    console.error('❌ Fetch / Mark-as-read failed:', data3);
    process.exit(1);
  }
  console.log(`✅ Mark as read & fetch SUCCESS! Total messages = ${data3.length}`);

  // 4. Fetch unread counts
  console.log('\n4. Checking unread counts for user 1...');
  const res4 = await fetch('http://localhost:5000/api/chat/unread/1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data4 = await res4.json();
  if (!res4.ok) {
    console.error('❌ Unread count failed:', data4);
    process.exit(1);
  }
  console.log('✅ Unread counts SUCCESS:', data4);

  console.log('\n🎉 ALL CHAT FLOW TESTS PASSED!');
  process.exit(0);
}

testChatFlow().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
