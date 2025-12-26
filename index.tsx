import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { 
  Mic, 
  BookOpen, 
  Home, 
  Settings, 
  Play, 
  Pause,
  CheckCircle,
  RefreshCw,
  Volume2,
  Headphones,
  Languages,
  ArrowRight,
  X,
  Bookmark,
  AlertCircle,
  Trash2,
  Plus,
  Sparkles,
  Key
} from "lucide-react";

// --- Types ---

declare global {
  // Fix: Define AIStudio interface and ensure window.aistudio uses the existing AIStudio type to match environment expectations.
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio: AIStudio;
  }
}

type Word = {
  text: string;
  translation: string;
  timestamp: number;
};

type Mistake = {
  id: number;
  question: string;
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  timestamp: number;
  type: 'translation' | 'listening';
};

type TranscriptEntry = {
  id: string;
  role: 'user' | 'model';
  text: string;
  translation?: string;
};

type DailyConfig = {
  date: string;
  dailyWord: {
    word: string;
    phonetic: string;
    translation: string;
    example: string;
    exampleCn: string;
  };
  liveTopics: { name: string; icon: string }[];
  listeningTopics: string[];
  translationTopics: string[];
  readingArticles: { id: number; title: string; source: string; prompt: string }[];
};

// --- Audio Utils ---

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function getWavHeader(bufferLength: number, sampleRate: number) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, bufferLength, true);
  return buffer;
}

function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// --- Shared UI Components ---

const Tooltip = ({ tooltip, onSave, onClose }: any) => {
  if (!tooltip || !tooltip.visible) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div 
        className="fixed z-50 bg-slate-800 text-white text-sm p-3 rounded-xl shadow-xl -translate-x-1/2 -translate-y-[110%] w-48 animate-in fade-in zoom-in duration-200"
        style={{ top: tooltip.y, left: tooltip.x }}
      >
         <div className="font-bold mb-1 text-xs text-slate-300 uppercase flex justify-between items-center">
           <span>{tooltip.word}</span>
           {!tooltip.loading && (
             <button 
              onClick={() => {
                onSave(tooltip.word, tooltip.definition);
                onClose();
              }}
              className="text-emerald-400 hover:text-emerald-300 p-1"
             >
               <Plus size={16} />
             </button>
           )}
         </div>
         <div className="text-slate-100 mb-1 leading-tight">{tooltip.definition}</div>
         <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-slate-800"></div>
      </div>
    </>
  );
};

// --- Shared Tooltip Logic Hook ---

const useWordLookup = (onSaveWord: (text: string, translation: string) => void) => {
  const [tooltip, setTooltip] = useState<{ visible: boolean; x: number; y: number; word: string; definition: string; loading: boolean; } | null>(null);

  const lookupWord = async (word: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({
       visible: true,
       x: rect.left + rect.width / 2,
       y: rect.top, 
       word: word,
       definition: "查询中...",
       loading: true
    });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Translate the English word "${word}" to Chinese. Just the translation.`,
      });
      const def = result.text?.trim() || "未知";
      setTooltip(prev => prev ? ({ ...prev, definition: def, loading: false }) : null);
    } catch (e) {
      setTooltip(prev => prev ? ({ ...prev, definition: "Error", loading: false }) : null);
    }
  };

  const InteractiveText = ({ text, className, isDark = false }: { text: string, className?: string, isDark?: boolean }) => {
    if (!text) return null;
    const parts = text.split(/([a-zA-Z]+(?:'[a-z]+)?)/);
    return (
      <span className={className}>
        {parts.map((part, index) => {
          if (/^[a-zA-Z]/.test(part)) {
             return (
               <span 
                key={index} 
                onClick={(e) => lookupWord(part, e)} 
                className={`cursor-pointer rounded-[2px] transition-colors ${
                  isDark 
                  ? 'hover:bg-emerald-500/30 hover:text-emerald-300' 
                  : 'hover:bg-emerald-100 hover:text-emerald-900'
                }`}
               >
                {part}
               </span>
             );
          }
          return <span key={index}>{part}</span>;
        })}
      </span>
    );
  };

  return { tooltip, setTooltip, lookupWord, InteractiveText };
};

// --- App Component ---

const App = () => {
  const [activeTab, setActiveTab] = useState<"home" | "live" | "translate" | "read" | "listen" | "review">("home");
  const [dailyConfig, setDailyConfig] = useState<DailyConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [needsApiKey, setNeedsApiKey] = useState(false);

  const [savedWords, setSavedWords] = useState<Word[]>(() => {
    const saved = localStorage.getItem("lingo_words");
    try {
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [mistakes, setMistakes] = useState<Mistake[]>(() => {
    const saved = localStorage.getItem("lingo_mistakes");
    try {
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem("lingo_words", JSON.stringify(savedWords));
  }, [savedWords]);

  useEffect(() => {
    localStorage.setItem("lingo_mistakes", JSON.stringify(mistakes));
  }, [mistakes]);

  const handleKeySelection = async () => {
    try {
      await window.aistudio.openSelectKey();
      setNeedsApiKey(false);
      // Proceed to try loading config again
      fetchDailyConfig();
    } catch (e) {
      console.error("API Key selection failed", e);
    }
  };

  const fetchDailyConfig = useCallback(async () => {
    setLoadingConfig(true);
    const today = new Date().toISOString().split('T')[0];
    const cached = localStorage.getItem("lingo_daily_config");
    
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.date === today) {
          setDailyConfig(parsed);
          setLoadingConfig(false);
          return;
        }
      } catch {}
    }

    try {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        setNeedsApiKey(true);
        setLoadingConfig(false);
        return;
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Generate a daily English learning config for date: ${today}. 
      Return strictly JSON with this structure:
      {
        "date": "${today}",
        "dailyWord": { "word": "resilience", "phonetic": "/rɪˈzɪl.jəns/", "translation": "韧性", "example": "Sentence...", "exampleCn": "Translation..." },
        "liveTopics": [ { "name": "Topic", "icon": "👋" } ],
        "listeningTopics": [ "Topic" ],
        "translationTopics": [ "Topic" ],
        "readingArticles": [ { "id": 1, "title": "Title", "source": "Source", "prompt": "Prompt" } ]
      }
      Generate 8 topics for live, 5 for listening, 5 for translation, 4 for reading.`;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const newConfig = JSON.parse(result.text || "{}");
      setDailyConfig(newConfig);
      localStorage.setItem("lingo_daily_config", JSON.stringify(newConfig));
    } catch (e: any) {
      console.error("Failed to fetch daily config", e);
      if (e.message?.includes("Requested entity was not found") || e.message?.includes("Network error")) {
        setNeedsApiKey(true);
      }
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    fetchDailyConfig();
  }, [fetchDailyConfig]);

  const addWord = (text: string, translation: string) => {
    if (savedWords.some(w => w.text.toLowerCase() === text.toLowerCase())) return;
    setSavedWords(prev => [{ text, translation, timestamp: Date.now() }, ...prev]);
  };

  const removeWord = (text: string) => {
    setSavedWords(prev => prev.filter(w => w.text !== text));
  };

  const addMistake = (mistake: Omit<Mistake, 'id' | 'timestamp'>) => {
    const newMistake = { ...mistake, id: Date.now(), timestamp: Date.now() };
    setMistakes(prev => [newMistake, ...prev]);
  };

  const removeMistake = (id: number) => {
    setMistakes(prev => prev.filter(m => m.id !== id));
  };

  if (needsApiKey) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center p-10 text-center gap-6">
         <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600">
           <Key size={40} />
         </div>
         <div className="space-y-2">
           <h1 className="text-xl font-bold text-slate-800">需要设置 API Key</h1>
           <p className="text-slate-500 text-sm">为了体验最新的 Native Audio 及 Gemini 3 模型，请选择一个已启用计费的项目 API Key。</p>
           <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="text-emerald-600 text-xs hover:underline">了解计费说明</a>
         </div>
         <button onClick={handleKeySelection} className="w-full max-w-xs bg-emerald-600 text-white font-bold py-3 rounded-xl shadow-lg flex items-center justify-center gap-2">
           <Settings size={18} /> 选择 API Key
         </button>
      </div>
    );
  }

  if (loadingConfig) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center p-10 text-center gap-4">
         <Sparkles size={48} className="text-emerald-500 animate-bounce" />
         <h1 className="text-xl font-bold text-slate-800">正在为你准备今日课程...</h1>
         <p className="text-slate-400 text-sm">正在同步今日全球动态...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 max-w-md mx-auto shadow-2xl overflow-hidden relative border-x border-slate-200 font-sans">
      <main className="flex-1 overflow-y-auto scrollbar-hide">
        {activeTab === "home" && <Dashboard onNavigate={setActiveTab} config={dailyConfig} />}
        {activeTab === "live" && <LiveTutor onSaveWord={addWord} topics={dailyConfig?.liveTopics || []} />}
        {activeTab === "translate" && <TranslationCoach onMistake={addMistake} topics={dailyConfig?.translationTopics || []} />}
        {activeTab === "read" && <ReadingGym onSaveWord={addWord} featuredArticles={dailyConfig?.readingArticles || []} />}
        {activeTab === "listen" && <ListeningLab onSaveWord={addWord} onMistake={addMistake} topics={dailyConfig?.listeningTopics || []} />}
        {activeTab === "review" && (
          <ReviewModule 
            words={savedWords} 
            mistakes={mistakes} 
            onRemoveWord={removeWord} 
            onRemoveMistake={removeMistake} 
          />
        )}
      </main>

      <nav className="bg-white border-t border-slate-200 px-2 py-3 flex justify-between items-center z-10 shrink-0">
        <NavButton icon={<Home size={22} />} label="主页" active={activeTab === "home"} onClick={() => setActiveTab("home")} />
        <NavButton icon={<Mic size={22} />} label="口语" active={activeTab === "live"} onClick={() => setActiveTab("live")} />
        <NavButton icon={<Headphones size={22} />} label="听力" active={activeTab === "listen"} onClick={() => setActiveTab("listen")} />
        <NavButton icon={<Languages size={22} />} label="翻译" active={activeTab === "translate"} onClick={() => setActiveTab("translate")} />
        <NavButton icon={<BookOpen size={22} />} label="阅读" active={activeTab === "read"} onClick={() => setActiveTab("read")} />
        <NavButton icon={<Bookmark size={22} />} label="复习" active={activeTab === "review"} onClick={() => setActiveTab("review")} />
      </nav>
    </div>
  );
};

const NavButton = ({ icon, label, active, onClick }: any) => (
  <button onClick={onClick} className={`flex flex-col items-center space-y-1 transition-colors px-1 flex-1 ${active ? "text-emerald-600" : "text-slate-400 hover:text-slate-600"}`}>
    {icon}
    <span className="text-[9px] font-medium">{label}</span>
  </button>
);

// --- Dashboard Component ---

const Dashboard = ({ onNavigate, config }: { onNavigate: (tab: any) => void, config: DailyConfig | null }) => {
  const speak = (text: string) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  };

  const dw = config?.dailyWord || {
    word: "Resilience",
    phonetic: "/rɪˈzɪl.jəns/",
    translation: "韧性；恢复力",
    example: "Building resilience helps you adapt to life's misfortunes.",
    exampleCn: "建立韧性有助于你适应生活中的不幸。"
  };

  return (
    <div className="p-5 space-y-6">
      <div className="bg-gradient-to-br from-emerald-600 to-teal-700 rounded-2xl p-5 text-white shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 p-3 opacity-10"><Bookmark size={100} /></div>
        <div className="relative z-10">
          <div className="flex items-center space-x-2 mb-3 opacity-90">
            <span className="text-xs font-bold uppercase tracking-widest border border-white/30 px-2 py-0.5 rounded-full">Daily Word • {config?.date}</span>
          </div>
          <div className="flex items-end gap-3 mb-2">
            <h3 className="text-3xl font-bold">{dw.word}</h3>
            <button onClick={() => speak(dw.word)} className="bg-white/20 hover:bg-white/30 p-2 rounded-full mb-1 transition-colors"><Volume2 size={18} /></button>
          </div>
          <p className="text-emerald-100 text-sm italic mb-4 font-mono">{dw.phonetic} • n. {dw.translation}</p>
          <div className="bg-white/10 rounded-xl p-3 backdrop-blur-sm border border-white/10">
            <p className="text-sm font-medium leading-relaxed">"{dw.example}"</p>
            <div className="flex justify-between items-center mt-2">
               <p className="text-xs text-emerald-200">{dw.exampleCn}</p>
               <button onClick={() => speak(dw.example)} className="text-emerald-200 hover:text-white"><Play size={14} /></button>
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <ActionCard title="口语私教" desc="Native Audio 对话" icon={<Mic size={24} className="text-rose-500" />} color="bg-rose-50 border-rose-100" onClick={() => onNavigate("live")} />
        <ActionCard title="听力实验室" desc="精选场景听力" icon={<Headphones size={24} className="text-indigo-500" />} color="bg-indigo-50 border-indigo-100" onClick={() => onNavigate("listen")} />
        <ActionCard title="翻译特训" desc="AI 反馈纠错" icon={<Languages size={24} className="text-blue-500" />} color="bg-blue-50 border-blue-100" onClick={() => onNavigate("translate")} />
        <ActionCard title="阅读健身房" desc="外刊精读深度练" icon={<BookOpen size={24} className="text-amber-500" />} color="bg-amber-50 border-amber-100" onClick={() => onNavigate("read")} />
      </div>
    </div>
  );
};

const ActionCard = ({ title, desc, icon, color, onClick }: any) => (
  <button onClick={onClick} className={`${color} border p-4 rounded-xl flex flex-col items-start space-y-3 transition-all active:scale-95 hover:shadow-md text-left h-full`}>
    <div className="p-2 bg-white rounded-lg shadow-sm">{icon}</div>
    <div>
      <h3 className="font-bold text-slate-800">{title}</h3>
      <p className="text-xs text-slate-500">{desc}</p>
    </div>
  </button>
);

// --- Review Module ---

const ReviewModule = ({ words = [], mistakes = [], onRemoveWord, onRemoveMistake }: any) => {
  const [activeTab, setActiveTab] = useState<'words' | 'mistakes'>('words');
  return (
    <div className="h-full flex flex-col bg-slate-50">
      <header className="bg-white border-b border-slate-200 p-4 sticky top-0 z-10">
        <h2 className="font-bold text-slate-800 text-xl mb-4">复习中心</h2>
        <div className="flex bg-slate-100 p-1 rounded-lg">
          <button onClick={() => setActiveTab('words')} className={`flex-1 py-2 text-sm font-bold rounded-md transition-all flex items-center justify-center gap-2 ${activeTab === 'words' ? 'bg-white shadow-sm text-emerald-600' : 'text-slate-400'}`}>
            <Bookmark size={16} /> 生词本 ({words.length})
          </button>
          <button onClick={() => setActiveTab('mistakes')} className={`flex-1 py-2 text-sm font-bold rounded-md transition-all flex items-center justify-center gap-2 ${activeTab === 'mistakes' ? 'bg-white shadow-sm text-rose-600' : 'text-slate-400'}`}>
            <AlertCircle size={16} /> 错题本 ({mistakes.length})
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'words' && (
          <div className="space-y-3">
            {words.length === 0 && <EmptyState text="暂无生词，阅读时点击单词即可添加" />}
            {words.map((w: Word) => (
              <div key={w.text} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex justify-between items-center group">
                <div>
                  <h4 className="font-bold text-lg text-slate-800">{w.text}</h4>
                  <p className="text-sm text-slate-500">{w.translation}</p>
                </div>
                <div className="flex gap-2">
                   <button onClick={() => { const u = new SpeechSynthesisUtterance(w.text); window.speechSynthesis.speak(u); }} className="p-2 text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 rounded-full"><Volume2 size={18} /></button>
                   <button onClick={() => onRemoveWord(w.text)} className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-full"><Trash2 size={18} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
        {activeTab === 'mistakes' && (
          <div className="space-y-4">
             {mistakes.length === 0 && <EmptyState text="太棒了，目前没有错题！" />}
             {mistakes.map((m: Mistake) => (
               <div key={m.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative">
                 <button onClick={() => onRemoveMistake(m.id)} className="absolute top-3 right-3 text-slate-300 hover:text-rose-500"><X size={16} /></button>
                 <span className="text-[10px] font-bold uppercase tracking-wider bg-rose-50 text-rose-600 px-2 py-1 rounded-md mb-2 inline-block">{m.type === 'translation' ? '翻译' : '听力'}</span>
                 <p className="font-medium text-slate-800 mb-2">{m.question}</p>
                 <div className="text-sm space-y-1 mb-3">
                    <p className="text-rose-600 line-through decoration-rose-300 decoration-2">{m.userAnswer}</p>
                    <p className="text-emerald-600 font-medium">{m.correctAnswer}</p>
                 </div>
                 <div className="bg-slate-50 p-3 rounded-lg text-xs text-slate-600 leading-relaxed"><span className="font-bold text-slate-700">解析：</span>{m.explanation}</div>
               </div>
             ))}
          </div>
        )}
      </div>
    </div>
  );
};

const EmptyState = ({text}: {text: string}) => (
  <div className="flex flex-col items-center justify-center h-64 text-slate-400 px-10 text-center"><Bookmark size={48} className="mb-4 opacity-20" /><p>{text}</p></div>
);

// --- Live Tutor Component ---

const LiveTutor = ({ onSaveWord, topics = [] }: { onSaveWord: (text: string, translation: string) => void, topics: { name: string; icon: string }[] }) => {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [topic, setTopic] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveUserText, setLiveUserText] = useState("");
  const [liveModelText, setLiveModelText] = useState("");
  const { tooltip, setTooltip, InteractiveText } = useWordLookup(onSaveWord);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptBoxRef = useRef<HTMLDivElement>(null);
  const accumulatedInputRef = useRef("");
  const accumulatedOutputRef = useRef("");

  useEffect(() => {
    if (transcriptBoxRef.current) transcriptBoxRef.current.scrollTop = transcriptBoxRef.current.scrollHeight;
  }, [transcript, liveUserText, liveModelText]);

  const translateText = async (text: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const resp = await ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: `Translate the following English text to Chinese: "${text}". Just the translation.`, });
      return resp.text?.trim() || "";
    } catch { return ""; }
  };

  const cleanup = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.then((s: any) => { if (s && typeof s.close === 'function') s.close(); });
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch {} });
    sourcesRef.current.clear();
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') audioContextRef.current.close().catch(() => {});
    if (inputContextRef.current && inputContextRef.current.state !== 'closed') inputContextRef.current.close().catch(() => {});
    setConnected(false); setConnecting(false); setTranscript([]); setLiveUserText(""); setLiveModelText(""); setTopic(null);
    accumulatedInputRef.current = ""; accumulatedOutputRef.current = "";
  }, []);

  const startSession = async (selectedTopic: string) => {
    setConnecting(true); setTopic(selectedTopic);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputContextRef.current = inputCtx;
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: `You are an English tutor. Topic: "${selectedTopic}". Be helpful and correct my errors briefly.`,
        },
        callbacks: {
          onopen: () => {
            setConnected(true); setConnecting(false);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor); scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) {
              accumulatedInputRef.current += msg.serverContent.inputTranscription.text;
              setLiveUserText(accumulatedInputRef.current);
            }
            if (msg.serverContent?.outputTranscription) {
              accumulatedOutputRef.current += msg.serverContent.outputTranscription.text;
              setLiveModelText(accumulatedOutputRef.current);
            }
            if (msg.serverContent?.turnComplete) {
               const finalUserText = accumulatedInputRef.current.trim();
               const finalModelText = accumulatedOutputRef.current.trim();
               const entriesToAdd: TranscriptEntry[] = [];
               const idPrefix = Date.now().toString();
               if (finalUserText) entriesToAdd.push({ id: idPrefix + '-u', role: 'user', text: finalUserText });
               if (finalModelText) entriesToAdd.push({ id: idPrefix + '-m', role: 'model', text: finalModelText });
               setTranscript(prev => [...prev, ...entriesToAdd]);
               accumulatedInputRef.current = ""; accumulatedOutputRef.current = "";
               setLiveUserText(""); setLiveModelText("");
               entriesToAdd.forEach(async (entry) => {
                 const translation = await translateText(entry.text);
                 setTranscript(prev => prev.map(t => t.id === entry.id ? { ...t, translation } : t));
               });
            }
            const data = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (data && outputCtx && outputCtx.state !== 'closed') {
              const audioBuffer = await decodeAudioData(decode(data), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer; source.connect(outputCtx.destination);
              const now = outputCtx.currentTime;
              const startTime = Math.max(nextStartTimeRef.current, now);
              source.start(startTime); nextStartTimeRef.current = startTime + audioBuffer.duration;
              sourcesRef.current.add(source); source.onended = () => sourcesRef.current.delete(source);
            }
          },
          onclose: () => cleanup(),
          onerror: (err) => { console.error(err); cleanup(); }
        }
      });
      sessionRef.current = sessionPromise;
    } catch (e) {
      console.error(e); alert("无法启动会话，请检查麦克风权限或 API Key。"); setConnecting(false); setTopic(null);
    }
  };

  if (!connected && !connecting) {
    return (
      <div className="h-full flex flex-col bg-slate-50 p-6">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">口语主题</h2>
        <div className="grid grid-cols-2 gap-3">
          {topics.map(t => (
            <button key={t.name} onClick={() => startSession(t.name)} className="p-4 bg-white border border-slate-200 hover:border-emerald-500 rounded-xl text-left transition-all flex flex-col gap-2">
              <span className="text-2xl">{t.icon}</span>
              <span className="font-bold text-slate-700 text-sm">{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (connecting) {
     return <div className="h-full flex items-center justify-center bg-slate-900 text-white flex-col gap-4">
        <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-emerald-400 font-bold">连接中...</p>
     </div>;
  }

  return (
    <div className="h-full flex flex-col relative bg-slate-900 text-white overflow-hidden">
      <div className="p-4 border-b border-slate-800 flex justify-between items-center z-10 shrink-0">
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div><span className="font-bold text-sm">{topic}</span></div>
        <button onClick={cleanup} className="bg-rose-500/20 text-rose-400 px-4 py-1.5 rounded-full text-xs font-bold hover:bg-rose-500/30">结束通话</button>
      </div>
      <Tooltip tooltip={tooltip} onSave={onSaveWord} onClose={() => setTooltip(null)} />
      <div ref={transcriptBoxRef} className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide pb-32">
        {transcript.map((t) => (
           <div key={t.id} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
              <div className={`max-w-[85%] p-4 rounded-2xl text-sm ${t.role === 'user' ? 'bg-emerald-600' : 'bg-slate-800 border border-slate-700'}`}>
                <InteractiveText text={t.text} isDark={true} />
                {t.translation && <p className="mt-2 text-[11px] opacity-60 border-t border-white/10 pt-2">{t.translation}</p>}
              </div>
           </div>
        ))}
        {liveUserText && <div className="flex flex-col items-end opacity-50"><div className="p-4 bg-emerald-600 rounded-2xl text-sm">{liveUserText}</div></div>}
        {liveModelText && <div className="flex flex-col items-start opacity-50"><div className="p-4 bg-slate-800 rounded-2xl text-sm border border-slate-700">{liveModelText}</div></div>}
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-slate-950 flex items-center justify-center flex-col gap-3 pointer-events-none">
         <div className="flex items-center gap-1.5 h-10">{[...Array(5)].map((_, i) => <div key={i} className="w-1.5 bg-emerald-400 rounded-full wave-bar" style={{ animationDelay: `${i * 0.1}s` }}></div>)}</div>
         <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">收听中...</p>
      </div>
    </div>
  );
};

// --- Listening Lab ---

const ListeningLab = ({ onSaveWord, onMistake, topics = [] }: any) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, any>>({});
  const [result, setResult] = useState<Record<number, boolean> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { tooltip, setTooltip, InteractiveText } = useWordLookup(onSaveWord);

  const generateLesson = async (selectedTopic: string) => {
    setLoading(true); setAudioUrl(null); setData(null); setAnswers({}); setResult(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Generate a story (120 words) about "${selectedTopic}" and 5 questions (2 TF, 2 single choice A-D, 1 multi choice A-D). Return JSON { "story": "...", "questions": [...] }`;
      const textResp = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt, config: { responseMimeType: "application/json" } });
      const lessonData = JSON.parse(textResp.text || "{}");
      setData(lessonData);
      const audioResp = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: { parts: [{ text: lessonData.story }] },
        config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
      });
      const base64Audio = audioResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
         const pcmBytes = decode(base64Audio);
         const wavHeader = getWavHeader(pcmBytes.length, 24000);
         const wavBlob = new Blob([wavHeader, pcmBytes], { type: 'audio/wav' });
         setAudioUrl(URL.createObjectURL(wavBlob));
      }
    } catch { alert("生成失败"); } finally { setLoading(false); }
  };

  const checkAnswers = () => {
    if (!data?.questions) return;
    const res: Record<number, boolean> = {};
    data.questions.forEach((q: any) => {
       const isCorrect = q.type === 'multi' ? JSON.stringify([...(answers[q.id] || [])].sort()) === JSON.stringify([...(q.answer || [])].sort()) : answers[q.id] === q.answer;
       res[q.id] = isCorrect;
       if (!isCorrect) onMistake({ question: q.text, userAnswer: String(answers[q.id]), correctAnswer: String(q.answer), explanation: q.explanation, type: 'listening' });
    });
    setResult(res);
  };

  return (
    <div className="h-full flex flex-col bg-indigo-50/50">
      <header className="bg-white border-b border-indigo-100 p-4 sticky top-0 z-10 flex items-center gap-2"><Headphones size={20} className="text-indigo-500" /><h2 className="font-bold text-slate-800">听力实验室</h2></header>
      <Tooltip tooltip={tooltip} onSave={onSaveWord} onClose={() => setTooltip(null)} />
      <div className="flex-1 overflow-y-auto p-6">
        {!data ? (
          <div className="space-y-4"><h3 className="text-sm font-bold text-slate-400">今日精选</h3><div className="flex flex-wrap gap-2">{topics.map((t: string) => <button key={t} onClick={() => generateLesson(t)} className="bg-white border border-slate-200 px-4 py-2 rounded-full text-sm hover:border-indigo-400">{t}</button>)}</div>{loading && <div className="text-center py-10"><RefreshCw className="animate-spin inline mr-2" />生成中...</div>}</div>
        ) : (
          <div className="space-y-6 pb-10">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-indigo-100 flex flex-col items-center gap-4">
              {audioUrl && <><audio ref={audioRef} src={audioUrl} onEnded={() => setIsPlaying(false)} className="hidden" /><button onClick={() => { if (isPlaying) audioRef.current?.pause(); else audioRef.current?.play(); setIsPlaying(!isPlaying); }} className="bg-indigo-600 text-white w-16 h-16 rounded-full flex items-center justify-center shadow-lg">{isPlaying ? <Pause size={32} /> : <Play size={32} className="ml-1" />}</button></>}
              <details className="w-full mt-2"><summary className="text-sm text-indigo-500 font-bold cursor-pointer text-center list-none mb-2">查看原文</summary><div className="text-slate-600 text-lg p-4 bg-slate-50 rounded-xl font-serif"><InteractiveText text={data.story} /></div></details>
            </div>
            {data.questions.map((q: any) => (
              <div key={q.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                <p className="font-medium text-slate-800 mb-4">{q.text}</p>
                <div className="grid gap-2">{q.options.map((opt: string) => {
                  const label = opt.split(":")[0];
                  const isSelected = q.type === 'multi' ? (answers[q.id] || []).includes(label) : answers[q.id] === label;
                  return <button key={opt} onClick={() => {
                    if (result) return;
                    if (q.type === 'multi') {
                      const cur = answers[q.id] || [];
                      setAnswers({ ...answers, [q.id]: cur.includes(label) ? cur.filter((i: string) => i !== label) : [...cur, label] });
                    } else setAnswers({ ...answers, [q.id]: label });
                  }} className={`text-left p-3 rounded-xl border transition-all ${isSelected ? "bg-indigo-600 text-white" : "bg-white text-slate-600"}`}>{opt}</button>;
                })}</div>
                {result && <div className={`mt-3 text-xs font-bold ${result[q.id] ? "text-emerald-600" : "text-rose-600"}`}>{result[q.id] ? "正确" : `错误，解析: ${q.explanation}`}</div>}
              </div>
            ))}
            <div className="flex gap-3"><button onClick={() => setData(null)} className="flex-1 bg-white border py-3 rounded-xl">返回</button><button onClick={checkAnswers} disabled={Object.keys(answers).length < 5} className="flex-[2] bg-slate-800 text-white py-3 rounded-xl">提交</button></div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- Translation Coach ---

const TranslationCoach = ({ onMistake, topics = [] }: any) => {
  const [exercises, setExercises] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [userAnswer, setUserAnswer] = useState<any>("");
  const [feedback, setFeedback] = useState<any>(null);

  const generateExercises = async (topic: string) => {
    setLoading(true); setExercises([]); setCurrentIndex(0); setFeedback(null); setUserAnswer("");
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Generate exactly 5 translation exercises about "${topic}": 2 single choice (CN-EN), 1 multiple choice (CN-EN), 1 blank (EN with _____, provide CN hint), 1 full sentence (CN-EN). Return JSON array of objects with { "type": "single"|"multi"|"blank"|"full", "src": "...", "options": ["A:...", ...], "answer": "A"|["A",...]| "word"|"full text", "hint": "..." }`;
      const result = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt, config: { responseMimeType: "application/json" } });
      setExercises(JSON.parse(result.text || "[]"));
    } catch { alert("生成失败"); } finally { setLoading(false); }
  };

  const checkAnswer = async () => {
    const current = exercises[currentIndex];
    setLoading(true);
    try {
      let isCorrect = false, explanation = "";
      if (current.type === 'single') isCorrect = userAnswer === current.answer;
      else if (current.type === 'multi') isCorrect = JSON.stringify([...(userAnswer || [])].sort()) === JSON.stringify([...(current.answer || [])].sort());
      else if (current.type === 'blank') isCorrect = userAnswer.trim().toLowerCase() === current.answer.trim().toLowerCase();
      else {
         const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
         const resp = await ai.models.generateContent({ 
           model: 'gemini-3-flash-preview', 
           contents: `Judge translation from CN: "${current.src}" to EN: "${userAnswer}". Compare with reference: "${current.answer}". Return JSON { "correct": boolean, "explanation": "Brief CN explanation of mistakes" }`, 
           config: { responseMimeType: "application/json" } 
         });
         const judge = JSON.parse(resp.text || "{}");
         isCorrect = judge.correct; explanation = judge.explanation;
      }
      const finalExp = isCorrect ? "回答正确！" : `${explanation || "翻译存在差异。"}\n\n正确的完整翻译: \n"${Array.isArray(current.answer) ? current.answer.join(", ") : current.answer}"`;
      setFeedback({ correct: isCorrect, explanation: finalExp });
      if (!isCorrect) onMistake({ question: current.src, userAnswer: String(userAnswer), correctAnswer: String(current.answer), explanation: finalExp, type: 'translation' });
    } catch { alert("校验失败"); } finally { setLoading(false); }
  };

  return (
    <div className="h-full flex flex-col bg-blue-50/50">
      <header className="bg-white border-b border-blue-100 p-4 sticky top-0 z-10 flex items-center gap-2"><Languages size={20} className="text-blue-500" /><h2 className="font-bold text-slate-800">翻译特训</h2></header>
      <div className="flex-1 overflow-y-auto p-6">
        {exercises.length === 0 ? (
          <div className="space-y-4"><h3 className="text-sm font-bold text-slate-400">今日专项</h3><div className="flex flex-wrap gap-2">{topics.map((t: string) => <button key={t} onClick={() => generateExercises(t)} className="bg-white border border-slate-200 px-4 py-2 rounded-full text-sm hover:border-blue-400">{t}</button>)}</div>{loading && <div className="text-center py-10">出题中...</div>}</div>
        ) : (
          <div className="max-w-sm mx-auto space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-100">
               <h3 className="text-xl font-medium text-slate-800 mb-8 font-serif">{exercises[currentIndex].src}</h3>
               {['single', 'multi'].includes(exercises[currentIndex].type) && <div className="space-y-3">{exercises[currentIndex].options.map((opt: string) => {
                 const label = opt.split(":")[0];
                 const isSel = exercises[currentIndex].type === 'multi' ? (userAnswer || []).includes(label) : userAnswer === label;
                 return <button key={opt} onClick={() => { if (feedback) return; if (exercises[currentIndex].type === 'multi') { const cur = userAnswer || []; setUserAnswer(cur.includes(label) ? cur.filter((i: any) => i !== label) : [...cur, label]); } else setUserAnswer(label); }} className={`w-full text-left p-4 rounded-xl border transition-all ${isSel ? "bg-blue-600 text-white" : "bg-white text-slate-600"}`}>{opt}</button>;
               })}</div>}
               {exercises[currentIndex].type === 'blank' && <input value={userAnswer} onChange={e => setUserAnswer(e.target.value)} disabled={!!feedback} placeholder="输入单词..." className="w-full border-b-2 py-3 outline-none" />}
               {exercises[currentIndex].type === 'full' && <textarea value={userAnswer} onChange={e => setUserAnswer(e.target.value)} disabled={!!feedback} placeholder="输入完整翻译..." className="w-full bg-slate-50 border p-4 rounded-xl h-32 resize-none" />}
            </div>
            {feedback && <div className={`p-5 rounded-xl border ${feedback.correct ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}><p className="text-sm leading-relaxed whitespace-pre-wrap">{feedback.explanation}</p></div>}
            {!feedback ? <button onClick={checkAnswer} disabled={!userAnswer || loading} className="w-full bg-slate-800 text-white py-4 rounded-xl shadow-lg">{loading ? "检查中..." : "核对答案"}</button> : <button onClick={() => { if (currentIndex < exercises.length - 1) { setCurrentIndex(currentIndex + 1); setUserAnswer(""); setFeedback(null); } else setExercises([]); }} className="w-full bg-blue-600 text-white py-4 rounded-xl shadow-lg">{currentIndex < exercises.length - 1 ? "下一题" : "完成"}</button>}
          </div>
        )}
      </div>
    </div>
  );
};

// --- Reading Gym ---

const ReadingGym = ({ onSaveWord, featuredArticles = [] }: any) => {
  const [article, setArticle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [showAns, setShowAns] = useState(false);
  const { tooltip, setTooltip, InteractiveText } = useWordLookup(onSaveWord);

  const generateArticle = async (prompt: string) => {
    setLoading(true); setArticle(null); setShowAns(false);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const textResp = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: `${prompt}. Provide exactly one MC question. Return JSON { "title": "...", "content": "...", "question": "...", "options": ["A:...", ...], "correctIndex": 0, "explanation": "..." }`, config: { responseMimeType: "application/json" } });
      setArticle(JSON.parse(textResp.text || "{}"));
    } catch { alert("生成失败"); } finally { setLoading(false); }
  };

  return (
    <div className="h-full flex flex-col bg-amber-50/50">
      <header className="bg-white border-b border-amber-100 p-4 sticky top-0 z-10 flex items-center gap-2"><BookOpen size={20} className="text-amber-500" /><h2 className="font-bold text-slate-800">阅读健身房</h2></header>
      <Tooltip tooltip={tooltip} onSave={onSaveWord} onClose={() => setTooltip(null)} />
      <div className="flex-1 overflow-y-auto p-6">
        {!article ? (
          <div className="space-y-4"><h3 className="text-sm font-bold text-slate-400">刊物推荐</h3>{featuredArticles.map((art: any) => <button key={art.id} onClick={() => generateArticle(art.prompt)} className="w-full bg-white p-5 rounded-xl border text-left shadow-sm"><div><span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-1 rounded-full">{art.source}</span></div><h4 className="font-bold mt-2">{art.title}</h4></button>)}{loading && <div className="text-center py-10">AI 正在撰稿...</div>}</div>
        ) : (
          <div className="space-y-8 pb-10">
            <button onClick={() => setArticle(null)} className="text-sm text-slate-500 flex items-center gap-1">← 返回</button>
            <article><h1 className="text-2xl font-bold mb-4 font-serif">{article.title}</h1><div className="bg-white p-6 rounded-2xl shadow-sm border text-xl leading-10 font-serif"><InteractiveText text={article.content || article.article} /></div></article>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h3 className="font-bold mb-4">阅读理解</h3><p className="mb-4 text-lg">{article.question}</p>
              <div className="space-y-3">{article.options.map((opt: string, idx: number) => <button key={idx} onClick={() => setShowAns(true)} className={`w-full text-left p-4 rounded-xl border transition-all ${showAns ? idx === article.correctIndex ? "bg-emerald-50 text-emerald-700" : "bg-slate-50 text-slate-400" : "bg-white"}`}>{opt}</button>)}</div>
              {showAns && <div className="mt-4 p-4 bg-blue-50 text-blue-800 rounded-xl text-sm italic">解析: {article.explanation}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);