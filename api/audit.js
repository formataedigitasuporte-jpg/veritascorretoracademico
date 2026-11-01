const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

function normalizeForShingling(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateWordShingles(text, k = 3) {
  const words = normalizeForShingling(text).split(" ").filter(w => w.length > 2);
  const shingles = new Set();
  if (words.length < k) {
    if (words.length > 0) shingles.add(words.join(" "));
    return shingles;
  }
  for (let i = 0; i <= words.length - k; i++) {
    shingles.add(words.slice(i, i + k).join(" "));
  }
  return shingles;
}

function calculateRealTextOverlap(sentence, externalText) {
  if (!sentence || !externalText) return 0;
  const setA = generateWordShingles(sentence, 3);
  const setB = generateWordShingles(externalText, 3);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const containmentScore = intersection / setA.size;

  const wordsA = new Set(normalizeForShingling(sentence).split(" ").filter(w => w.length > 4));
  const wordsB = new Set(normalizeForShingling(externalText).split(" ").filter(w => w.length > 4));
  let wordHits = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) wordHits++;
  }
  const lexicalOverlap = wordsA.size > 0 ? wordHits / wordsA.size : 0;

  return Math.min(1, Number((containmentScore * 0.65 + lexicalOverlap * 0.35).toFixed(3)));
}

const NORMATIVE_REGEX_LIST = [
  { cat: "Estrutura ABNT", rx: /\b(RESUMO|ABSTRACT|INTRODUÇÃO|OBJETIVO GERAL|OBJETIVOS ESPECÍFICOS|METODOLOGIA|MATERIAIS E MÉTODOS|RESULTADOS E DISCUSSÃO|CONSIDERAÇÕES FINAIS|CONCLUSÃO|REFERÊNCIAS(?: BIBLIOGRÁFICAS)?)\b/gi },
  { cat: "Ética em Pesquisa (CEP)", rx: /\b(Comitê de Ética em Pesquisa(?:\s*com Seres Humanos)?\s*\(CEP\)|Termo de Consentimento Livre e Esclarecido\s*\(TCLE\)|Resolução\s*(?:CNS\s*)?nº\s*(?:466\/2012|510\/2016))\b/gi },
  { cat: "Saúde (ANVISA/COFEN/COREN/MS)", rx: /\b((?:Resolução|RDC|Portaria|Nota Técnica|Parecer)\s*(?:COFEN|COREN(?:-[A-Z]{2})?|ANVISA|CFM|CRM|CREMERJ|MS|GM\/MS)?\s*(?:nº|n\.)?\s*[\d.,\/-]+|Agência Nacional de Vigilância Sanitária\s*\(ANVISA\)|Conselho Federal de Enfermagem\s*\(COFEN\)|Conselho Regional de Enfermagem\s*\(COREN(?:-[A-Z]{2})?\)|Sistema Único de Saúde\s*\(SUS\)|Sistematização da Assistência de Enfermagem\s*\(SAE\))\b/gi },
  { cat: "Direito & Legislação (Leis/CTN/CF/STJ)", rx: /\b((?:artigo|art\.)\s*\d+[º°]?(?:,\s*(?:parágrafo único|§\s*\d+[º°]?|inciso\s*[IVXLCDM]+|inc\.\s*[IVXLCDM]+))?\s*(?:da|do)?\s*(?:Constituição Federal(?: de 1988)?|Código\s+Tributário\s+Nacional|Código\s+[A-Za-zÀ-ú\s]+|CTN|CPC|CLT|CDC|ECA|Lei\s*(?:Complementar|Federal|nº)?\s*[\d.\/-]+)?|Código Tributário Nacional|Constituição da República Federativa do Brasil de 1988|Lei\s*(?:Complementar\s*|Federal\s*)?nº\s*[\d.\/-]+(?:\s*de\s*\d{4})?|Súmula(?:\s*Vinculante)?\s*(?:nº\s*)?\d+\s*do\s*(?:STF|STJ|TST)|Superior Tribunal de Justiça|Supremo Tribunal Federal)\b/gi },
  { cat: "Educação / Normas Técnicas", rx: /\b(Base Nacional Comum Curricular\s*\(BNCC\)|Lei de Diretrizes e Bases da Educação Nacional\s*\(LDB\)|Lei Geral de Proteção de Dados(?:\s*Pessoais)?\s*\(LGPD\)|ABNT\s*NBR\s*\d+(?::\d{4})?|ISO(?:\/IEC)?\s*\d+|DSM-5(?:-TR)?)\b/gi }
];

function extractNormativeSpans(sentence, customTerms = []) {
  const spans = [];
  let unshieldedText = sentence;

  NORMATIVE_REGEX_LIST.forEach(item => {
    unshieldedText = unshieldedText.replace(item.rx, (match) => {
      spans.push({ category: item.cat, text: match.trim(), words: match.trim().split(/\s+/).length });
      return " ";
    });
  });

  customTerms.forEach(term => {
    if (term && term.trim().length > 2) {
      const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      unshieldedText = unshieldedText.replace(new RegExp(escaped, "gi"), (match) => {
        spans.push({ category: "Instituição / Termo Blindado", text: match.trim(), words: match.trim().split(/\s+/).length });
        return " ";
      });
    }
  });

  return { spans, unshieldedText: unshieldedText.replace(/\s+/g, " ").trim() };
}

function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      positions.forEach(pos => { words[pos] = word; });
    }
  }
  return words.filter(Boolean).join(" ");
}

async function searchAcademicDatabases(querySentence) {
  const cleanQuery = querySentence
    .replace(/[^A-Za-zÀ-ú0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 8)
    .join(" ");

  if (cleanQuery.length < 12) return [];
  const matches = [];

  try {
    const [openAlexRes, crossrefRes, s2Res] = await Promise.allSettled([
      fetch(`https://api.openalex.org/works?search=${encodeURIComponent(cleanQuery)}&per-page=2`),
      fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanQuery)}&rows=2`),
      fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(cleanQuery)}&limit=2&fields=title,authors,year,abstract,externalIds`)
    ]);

    if (openAlexRes.status === "fulfilled" && openAlexRes.value.ok) {
      const oaData = await openAlexRes.value.json();
      (oaData.results || []).forEach(work => {
        const abstractText = reconstructOpenAlexAbstract(work.abstract_inverted_index);
        const compareTarget = `${work.display_name || ""} ${abstractText}`;
        const overlap = calculateRealTextOverlap(querySentence, compareTarget);
        const firstAuthor = work.authorships?.[0]?.author?.display_name || "Autor Indexado";
        matches.push({
          provider: "OpenAlex",
          title: work.display_name || "Publicação Científica",
          author: firstAuthor.split(" ").pop().toUpperCase(),
          year: work.publication_year || "s.d.",
          url: work.doi || work.id || "https://openalex.org",
          overlapScore: overlap
        });
      });
    }

    if (crossrefRes.status === "fulfilled" && crossrefRes.value.ok) {
      const crData = await crossrefRes.value.json();
      (crData.message?.items || []).forEach(item => {
        const title = Array.isArray(item.title) ? item.title[0] : (item.title || "");
        const overlap = calculateRealTextOverlap(querySentence, title);
        const fam = item.author?.[0]?.family || "AUTOR";
        const year = item.issued?.["date-parts"]?.[0]?.[0] || "s.d.";
        matches.push({
          provider: "Crossref DOI",
          title: title,
          author: fam.toUpperCase(),
          year: year,
          url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : "https://crossref.org"),
          overlapScore: overlap
        });
      });
    }

    if (s2Res.status === "fulfilled" && s2Res.value.ok) {
      const s2Data = await s2Res.value.json();
      (s2Data.data || []).forEach(paper => {
        const compareTarget = `${paper.title || ""} ${paper.abstract || ""}`;
        const overlap = calculateRealTextOverlap(querySentence, compareTarget);
        const firstAuthor = paper.authors?.[0]?.name || "Autor S2";
        const doi = paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : "https://semanticscholar.org";
        matches.push({
          provider: "Semantic Scholar",
          title: paper.title || "Artigo Científico",
          author: firstAuthor.split(" ").pop().toUpperCase(),
          year: paper.year || "s.d.",
          url: doi,
          overlapScore: overlap
        });
      });
    }
  } catch (err) {
    console.warn("Aviso APIs externas:", err.message);
  }

  return matches.sort((a, b) => b.overlapScore - a.overlapScore);
}

app.post("/api/audit", async (req, res) => {
  try {
    const {
      fullText = "",
      documentTitle = "TCC Auditado",
      customInstitutions = [],
      citationStyle = "both",
      runExternalSearch = true
    } = req.body;

    if (!fullText || fullText.trim().length < 20) {
      return res.status(400).json({ error: "Texto insuficiente para auditoria." });
    }

    const lines = fullText.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    const bibliography = [];
    const bodyParagraphs = [];
    let inRefSection = false;

    lines.forEach((line, idx) => {
      const cleanHeading = line.replace(/^[\d.\s-]+/, "").trim();
      const isRefHeader = (lines.length <= 15 || idx >= Math.floor(lines.length * 0.35)) &&
        !/\.{3,}|\s+\d+$/.test(line) &&
        /^(?:REFERÊNCIAS|REFERÊNCIAS BIBLIOGRÁFICAS|BIBLIOGRAFIA)$/i.test(cleanHeading);

      if (isRefHeader) {
        inRefSection = true;
        return;
      }

      if (inRefSection && line.length > 18) {
        const numMatch = line.match(/^\[?(\d{1,3})\]?[.) -]+\s*(.+)/);
        const refNumber = numMatch ? numMatch[1] : String(bibliography.length + 1);
        const cleanRef = numMatch ? numMatch[2] : line;
        const yearMatch = cleanRef.match(/\b(19\d{2}|20\d{2})\b/);
        const authorMatch = cleanRef.match(/^([A-ZÀ-Ú][A-Za-zÀ-ú]+)/);

        bibliography.push({
          index: refNumber,
          author: authorMatch ? authorMatch[1].toUpperCase() : "AUTOR",
          year: yearMatch ? yearMatch[1] : "2023",
          fullEntry: line
        });
      } else if (!inRefSection) {
        bodyParagraphs.push(line);
      }
    });

    const allAnalyzedSentences = [];
    const candidatesForWebSearch = [];

    bodyParagraphs.forEach((para, pIdx) => {
      const protectedPara = para.replace(/\b(art|arts|inc|par|n|nº|fl|fls|p|pp|vol|v|ed|et al|dr|dra|prof)\./gi, "$1__DOT__");
      const rawSentences = protectedPara
        .split(/([.!?]+)\s+/)
        .reduce((acc, curr, i, arr) => {
          if (i % 2 === 0 && curr.trim()) {
            acc.push((curr + (arr[i + 1] || "")).replace(/__DOT__/g, ".").trim());
          }
          return acc;
        }, []);

      rawSentences.forEach((sent, sIdx) => {
        const { spans, unshieldedText } = extractNormativeSpans(sent, customInstitutions);
        const totalWords = sent.split(/\s+/).filter(Boolean).length;
        const shieldedWords = spans.reduce((acc, sp) => acc + sp.words, 0);
        const unshieldedWords = Math.max(0, totalWords - shieldedWords);

        const hasAbnt = /\([A-ZÀ-Ú][A-Za-zÀ-ú\s.;,&]+\s*,\s*(?:19|20)\d{2}/.test(sent) || /\b[A-ZÀ-Ú][a-zà-ú]+(?:\s+et\s+al\.)?\s*\((?:19|20)\d{2}\)/.test(sent);
        const hasNumeric = /\[(\d+(?:\s*[,;-]\s*\d+)*)\]|\((\d{1,3})\)\s*[.;]?$|[¹²³⁴⁵⁶⁷⁸⁹⁰]+/.test(sent);
        const hasNarrativePlusParaEnd = /\b(?:segundo|conforme|para|de acordo com|leciona|sustenta|ensina)\s+[A-ZÀ-Ú][a-zà-ú]{2,}/i.test(sent) && /\[(\d+)\]|\((\d{1,3})\)\s*[.;]?$|[¹²³⁴⁵⁶⁷⁸⁹⁰]+/.test(para);

        const isCited = hasAbnt || hasNumeric || hasNarrativePlusParaEnd;
        const hasAiMarker = /\b(nesse contexto|vale ressaltar|importa destacar|ademais|outrossim|em suma|depreende-se|crucial|fundamental|meticulosamente|holístic[oa]|cenário contemporâneo|otimiza os indicadores|mitigar danos)\b/i.test(unshieldedText);

        let statusColor = "green";
        let statusLabel = "🟢 CITAÇÃO OU NORMA VÁLIDA";
        let reason = "Frase devidamente referenciada ou protegida por norma técnica/legal.";

        if (hasAiMarker) {
          statusColor = "purple";
          statusLabel = "🟣 MARCADOR DE ESTILO IA";
          reason = "Contém conectivos ou adjetivos padronizados de LLMs na parte não normativa da frase.";
        } else if (!isCited && unshieldedWords >= 15) {
          statusColor = "red";
          statusLabel = "🔴 AFIRMAÇÃO SEM FONTE";
          reason = "Afirmação conceitual extensa sem citação ABNT nem numeração Vancouver.";
          if (candidatesForWebSearch.length < 5) {
            candidatesForWebSearch.push({ pIdx, sIdx, text: unshieldedText });
          }
        } else if (!isCited && unshieldedWords < 15 && spans.length === 0) {
          statusColor = "blue";
          statusLabel = "🔵 DESCRITIVA / AUTORAL";
          reason = "Frase curta de transição ou conectivo autoral próprio.";
        }

        allAnalyzedSentences.push({
          sId: `p-${pIdx}-s-${sIdx}`,
          pIdx,
          sIdx,
          text: sent,
          totalWords,
          shieldedWords,
          unshieldedWords,
          shieldedSpans: spans,
          isCited,
          statusColor,
          statusLabel,
          reason,
          externalMatches: []
        });
      });
    });

    if (runExternalSearch && candidatesForWebSearch.length > 0) {
      for (const cand of candidatesForWebSearch) {
        const matches = await searchAcademicDatabases(cand.text);
        const target = allAnalyzedSentences.find(s => s.pIdx === cand.pIdx && s.sIdx === cand.sIdx);
        if (target && matches.length > 0) {
          target.externalMatches = matches.slice(0, 2);
        }
      }
    }

    const totalWords = allAnalyzedSentences.reduce((a, b) => a + b.totalWords, 0) || 1;
    const shieldedWords = allAnalyzedSentences.reduce((a, b) => a + b.shieldedWords, 0);
    const unreferencedWords = allAnalyzedSentences.filter(s => s.statusColor === "red").reduce((a, b) => a + b.unshieldedWords, 0);
    const aiStyleWords = allAnalyzedSentences.filter(s => s.statusColor === "purple").reduce((a, b) => a + b.unshieldedWords, 0);

    const shieldedPct = Math.round((shieldedWords / totalWords) * 100);
    const netRedRiskPct = Math.round((unreferencedWords / totalWords) * 100);
    const aiStylePct = Math.round((aiStyleWords / totalWords) * 100);
    const grossSimilarityPct = Math.min(100, shieldedPct + netRedRiskPct);

    const verificationCode = "VRTS-" + crypto.createHash("sha256").update(fullText).digest("hex").slice(0, 10).toUpperCase();

    return res.json({
      success: true,
      verificationCode,
      documentTitle,
      metrics: {
        totalParagraphs: bodyParagraphs.length,
        totalSentences: allAnalyzedSentences.length,
        totalWords,
        shieldedPct,
        netRedRiskPct,
        aiStylePct,
        grossSimilarityPct,
        bibliographyCount: bibliography.length
      },
      bibliography,
      sentences: allAnalyzedSentences
    });
  } catch (error) {
    return res.status(500).json({ error: "Falha interna no servidor: " + error.message });
  }
});

app.post("/api/rewrite", async (req, res) => {
  try {
    const { sentence, documentContext = "", referenceToCite = null, citationStyle = "abnt", clientApiKey = "" } = req.body;
    const apiKey = process.env.GEMINI_API_KEY || clientApiKey || "";

    const citationInstruction = referenceToCite
      ? (citationStyle === "numeric"
          ? `Ancore a frase com a referência numérica exata [${referenceToCite.index}] da bibliografia do aluno.`
          : `Ancore a frase citando formalmente (${referenceToCite.author}, ${referenceToCite.year}) da bibliografia do aluno.`)
      : "Mantenha as citações existentes sem inventar autores.";

    const ragPrompt = `Você é um orientador acadêmico rigoroso em normas ABNT e Vancouver.
CONTEXTO DO TCC: "${documentContext.slice(0, 500)}"
TAREFA: Reescreva a frase abaixo com paráfrase acadêmica profunda em português formal do Brasil, preservando todos os números de leis/artigos/resoluções intocáveis, eliminando clichês de IA e cumprindo esta regra: ${citationInstruction}
Retorne APENAS a frase final reescrita:

"${sentence}"`;

    if (apiKey) {
      const isBearer = apiKey.startsWith("AQ.") || apiKey.startsWith("ya29.");
      const url = isBearer
        ? "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

      const headers = { "Content-Type": "application/json" };
      if (isBearer) headers["Authorization"] = `Bearer ${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: ragPrompt }] }],
          generationConfig: { temperature: 0.35 }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const rewritten = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (rewritten) {
          return res.json({ success: true, rewritten: rewritten.replace(/^["']|["']$/g, "") });
        }
      }
    }

    return res.status(400).json({ success: false, error: "Chave Gemini não configurada." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
}

module.exports = app;
