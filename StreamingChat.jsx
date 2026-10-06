import React, { useState, useRef, useEffect } from 'react';

const StreamingChat = () => {
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const containerRef = useRef(null);

  // Simulasi API streaming dari server
  const fetchStream = async () => {
    setIsStreaming(true);
    setText('');

    // Simulasi data yang datang dari server (Token demi token)
    const mockResponse = "Halo! Saya adalah AI Agent. Saya sedang mengirimkan pesan ini secara streaming agar Anda bisa membacanya kata demi kata dengan lebih nyaman.";
    const tokens = mockResponse.split(' ');

    for (const token of tokens) {
      await new Promise((resolve) => setTimeout(resolve, 100)); // Simulasi jeda network
      setText((prev) => prev + token + ' ');
      
      // Auto-scroll ke bawah saat streaming
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }
    setIsStreaming(false);
  };

  return (
    <div className="p-6 max-w-lg mx-auto bg-white rounded-xl shadow-md">
      <h2 className="text-xl font-bold mb-4">Streaming AI Agent</h2>
      
      <div 
        ref={containerRef}
        className="h-40 overflow-y-auto p-4 bg-gray-100 rounded mb-4 border border-gray-200"
      >
        <p className="whitespace-pre-wrap">{text || "Klik tombol untuk memulai..."}</p>
      </div>

      <button 
        onClick={fetchStream}
        disabled={isStreaming}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
      >
        {isStreaming ? 'Sedang mengetik...' : 'Mulai Streaming'}
      </button>
    </div>
  );
};

export default StreamingChat;
