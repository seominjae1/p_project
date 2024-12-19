const express = require('express');
const mariadb = require('mariadb');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const schedule = require('node-schedule');
const { findSimilarTitles, getSimilarTitles } = require('./test');


const app = express();
app.use(cors());
app.use(express.json());


app.use('/help', express.static(path.join(__dirname, 'image')));

// MariaDB 연결 설정
const db = mariadb.createPool({
    host: 'localhost',
    user: 'dbid233',
    password: 'dbpass233',
    database: 'db24327',
    port: 3306,
    connectionLimit: 20,
});

// Python 스크립트 절대 경로 설정
const pythonScriptPath = "/home/t24327/svr/AI/model_predict.py";
const headlineScriptPath = "/home/t24327/svr/src/headline.py";

// 데이터베이스에서 예측 결과 조회
async function getPredictionFromDB(url) {
    let conn;
    try {
        conn = await db.getConnection(); //데이터베이스와 커넥션 설정
        const result = await conn.query( //sql문 실행
            `SELECT p.real_news_probability, p.fake_news_probability, sa.title 
             FROM predictions p 
             JOIN scraped_articles sa ON p.article_id = sa.id 
             WHERE sa.url = ?`,
            [url]
        );

        if (result.length > 0) {
            console.log('Debug: Found existing prediction in DB');
            return result[0]; // 예측 결과 반환
        }
        return null; // 결과가 없으면 null 반환
    } finally {
        if (conn) conn.release(); //커넥션풀로 커넥션 반환
    }
}

// Python 스크립트 실행 함수
function runPythonScript(url) {
    return new Promise((resolve, reject) => {
        const python = spawn('python', [pythonScriptPath, url]); //headline.py로 url전달

        python.stdout.on('data', (data) => {
            console.log(`Python Output: ${data}`); //python스크립트에서 출력된 데이터를 콘솔에서 출력
        });

        python.stderr.on('data', (data) => {
            console.error(`Python 에러: ${data}`); //python스크립트에서 출력된 에러를 콘솔에서 출력
        });

        python.on('close', (code) => {             //python스크립트가 종료되었을 경우
            if (code !== 0) {
                return reject(new Error('Python script execution failed.')); //정상적으로 종료되지 않을 경우 에러를 반환
            }
            resolve(); // Python 스크립트 성공적으로 종료함을 알려줌
        });
    });
}

// 기사 크롤링 함수
async function scrapeArticle(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const $ = cheerio.load(response.data); //cheerio를 사용하여 html데이터를 로드, html을 파싱
        const title = $('#title_area').text().trim(); //title_area요소의 텍스트 추출
        const content = $('#dic_area').text().trim().replace(/\n|\t/g, '').trim(); //dic_area요소의 텍스트 추출 후 공백 문자 제거

        return { url, title, content }; //url, 제목, 본문 내용을 객체 형태로 반환
    } catch (error) {
        console.error('Scraping error:', error); //오류가 났을 경우 경고메세지
        throw error;
    }
}

// 크롤링 데이터 저장 함수
async function saveScrapedArticle(url, title, content) {
    let conn;
    try {
        conn = await db.getConnection(); //db커넥트 풀을 가져옴

        //찾고자 하는 데이터를 검색하고 존재하지 않는 경우 저장
        const existing = await conn.query('SELECT id FROM scraped_articles WHERE url = ?', [url]); //scraped_articles테이블의 url이 같은 데이터의 id를 찾아옴
        if (existing.length > 0) {
            console.log('Debug: Existing article found in DB');
            return existing[0].id; //찾고자 하는 데이터와 같은 데이터가 존재할 경우 id를 반환
        }
        
        //찾고자 하는 데이터가 없는 경우 해당 데이터를 저장 후 id를 반환
        const result = await conn.query(
            'INSERT INTO scraped_articles (url, title, content, created_at) VALUES (?, ?, ?, NOW())',
            [url, title, content]
        );
        return result.insertId;
    } finally {
        if (conn) conn.release();
    }
}

// 헤드라인 뉴스 크롤링 및 데이터 반환 함수
function runHeadlineScript() {
    //promise객체를 생성하여 비동기 작업 처리
    return new Promise((resolve, reject) => {
        //새 프로세스를 생성하고 headline.py를 실행
        const python = spawn('python', [headlineScriptPath]);

        let data = '';
        //스크립트의 출력 데이터를 받아 data에 추가
        python.stdout.on('data', (chunk) => {
            data += chunk.toString();
        });
        //스크립트의 에러 데이터를 받아 에러 메세지로 출력
        python.stderr.on('data', (data) => {
            console.error(`Headline Script Error: ${data}`);
        });
        //파이썬 스크립트가 종료되었을 경우
        python.on('close', (code) => {
            //파이썬 스크립트 실행이 정상적으로 종료되지 얺은 경우 오류 출력
            if (code !== 0) {
                return reject(new Error('Headline script execution failed.'));
            }
            try {
                const headlines = JSON.parse(data); // JSON 데이터 파싱
                resolve(headlines); //resolve함수를 통해 정상적으로 파이썬 스크립트가 종료되었음을 알림
            } catch (error) {
                reject(new Error('Failed to parse headline script output.'));
            }
        });
    });
}

// API 엔드포인트
app.post('/api/receive-url', async (req, res) => {
    //http요청에서 url속성값을 추출
    const { url } = req.body;
    //정규 표현식을 정의
    const naverNewsRegex = /^https?:\/\/n\.news\.naver\.com\/((mnews\/)?(hotissue\/)?article\/)/
    
    if (!url) {
        return res.status(400).send('URL is required'); //url이 들어오지 않는다면 400오류 전송
    }
    
    if (!naverNewsRegex.test(url)) { //정규식으로 검사
        return res.status(400).json({ error: '올바른 뉴스 페이지가 아닙니다' }); //올바른 정규식이 아닐 경우 에러 반환
    }

    try {
        // 데이터베이스에서 예측 결과 확인
        const existingPrediction = await getPredictionFromDB(url);
        if (existingPrediction) {
            const sim = await  getSimilarTitles(existingPrediction.title)   //유사한 기사를 찾아 제목, url, 확률을 가져와 출력력
            console.log(sim)
            return res.json({ ...existingPrediction, sim });                // 기존 예측 결과 반환 유사도까지
        }

        // 기사 크롤링 및 저장
        const article = await scrapeArticle(url);                           //url을 전달하여 크롤링 실행

        const sim = await getSimilarTitles(article.title)                   //해당 크롤링 데이터를 토대로 유사한 기사를 검색

        const articleId = await saveScrapedArticle(article.url, article.title, article.content); //크롤링 데이터를 저장

        // Python 스크립트 실행
        await runPythonScript(url);

        // 데이터베이스에서 예측 결과 조회
        const prediction = await getPredictionFromDB(url);

        if (!prediction) { //예측 결과가 데이터베이스에 없을 경우
            return res.status(500).send('Prediction not found in the database.');
        }

        console.log('Debug: Prediction from DB after script execution:', prediction);

        console.log(sim)
        return res.json({ ...prediction, sim }) //prediction의 모든 키-값을 복사한 후 sim을 추가하여 json형식으로 전송
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send({ error: 'Internal server error', details: error.message });
    }
});

// 헤드라인 데이터 조회 API
app.get('/api/headlines', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();    //데이터베이스 연결을 가져옴
        //데이터베이스에서 1시간 내로 만들어진 데이터를 가져옴
        const results = await conn.query(`
            SELECT 
                h.press_name, h.url, sa.title, p.real_news_probability, p.fake_news_probability
            FROM 
                headline h
            JOIN 
                scraped_articles sa ON h.url = sa.url
            JOIN 
                predictions p ON sa.id = p.article_id
            WHERE 
                h.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
            ORDER BY 
                h.created_at DESC
        `);

        res.json(results);  //json방식으로 전송
    } catch (error) {
        console.error('Error fetching headlines:', error);
        res.status(500).send('Error fetching headlines');
    } finally {
        if (conn) conn.release();
    }
});

// 헤드라인 크롤링 즉시 실행 API
app.get('/api/test-headlines', async (req, res) => {
    try {
        console.log('즉시 헤드라인 크롤링 및 분석 작업 시작');

        // 헤드라인 크롤링 스크립트 실행
        const headlines = await runHeadlineScript();
        console.log('헤드라인 크롤링 완료:', headlines);

        const conn = await db.getConnection();
        try {
            for (const { press_name, title, url } of headlines) {
                try {
                    // 헤드라인은 항상 저장
                    await conn.query(
                        'INSERT INTO headline (press_name, url, created_at) VALUES (?, ?, NOW())',
                        [press_name, url]
                    );

                    // scraped_articles에 중복된 URL인지 확인
                    const existing = await conn.query('SELECT id FROM scraped_articles WHERE url = ?', [url]);
                    if (existing.length > 0) {
                        console.log(`중복 URL 발견, 스킵: ${url}`);
                        continue;
                    }

                    // 기사 본문 크롤링
                    const article = await scrapeArticle(url);

                    // 본문 내용이 있을 때만 scraped_articles에 저장
                    if (article.content) {
                        const articleId = await saveScrapedArticle(article.url, article.title, article.content);
                        console.log(`기사 저장 완료: ${article.title}`);

                        // Python 스크립트 실행
                        await runPythonScript(url);

                        // 예측 결과 데이터베이스 조회
                        const prediction = await getPredictionFromDB(url);

                        if (prediction) {
                            console.log(`기사 분석 완료: ${article.title}, 결과:`, prediction);
                        } else {
                            console.warn(`예측 결과를 찾을 수 없습니다: ${url}`);
                        }
                    } else {
                        console.warn(`본문 크롤링 실패: ${url}`);
                    }
                } catch (error) {
                    console.error(`헤드라인 저장 및 분석 중 오류 발생 (${url}):`, error.message);
                }
            }

            console.log('모든 헤드라인 크롤링 및 분석 완료');
            res.status(200).send('헤드라인 크롤링 및 분석 작업 완료');
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('헤드라인 작업 중 오류 발생:', error);
        res.status(500).send('헤드라인 작업 중 오류 발생');
    }
});

//웹페이지 가이드
app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'help.html'));
})

// 1시간마다 헤드라인 크롤링 및 분석 실행 /0 * * * * = 1시간, */3 * * * * = 3분
schedule.scheduleJob('0 * * * *', async () => { //매 정각마다 스케쥴을 예약하여 실행되도록
    console.log('헤드라인 크롤링 및 분석 작업 시작');
    try {
        const headlines = await runHeadlineScript();    //헤드라인 크롤링 함수를 사용하여 각 언론사 뉴스를 가져와 상위 다섯 개의 기사 저장
        console.log('헤드라인 크롤링 완료:', headlines);

        const conn = await db.getConnection();  //커넥션 가져옴
        try {
            for (const { press_name, title, url } of headlines) {   //headlines배열을 순회하여 각 항목의 언론사, 타이틀, url를 추출하여 변수로 사용
                try {
                    await conn.query(
                        //헤드라인으로 들어오는 뉴스가 중복될 수도 있기 때문에 sql문에 IGNORE을 사용하여 headline테이블에 언론사, url, 저장한 시각 데이터를 저장
                        'INSERT IGNORE INTO headline (press_name, url, created_at) VALUES (?, ?, NOW())',
                        [press_name, url]
                    );

                    const article = await scrapeArticle(url); //url을 전달하여 크롤링 실행행

                    if (article.content) {
                        //scrapeArticle함수를 실행하여 url을 바탕으로 뉴스 제목, 본문 그리고 url을 json형식으로 만든 후 article에 저장
                        const articleId = await saveScrapedArticle(article.url, article.title, article.content);
                        console.log(`기사 저장 완료: ${article.title}`);

                        // Python 스크립트 실행
                        await runPythonScript(url);

                        // 예측 결과를 데이터베이스 조회
                        const prediction = await getPredictionFromDB(url);

                        if (prediction) { //성공적으로 예측 결과가 들어올 경우 결과 출력
                            console.log(`기사 분석 완료: ${article.title}, 결과:`, prediction);
                        } else {
                            console.warn(`예측 결과를 찾을 수 없습니다: ${url}`);
                        }
                    } else {
                        console.warn(`본문 크롤링 실패: ${url}`);
                    }
                } catch (error) {
                    console.error(`헤드라인 처리 중 오류 발생 (${url}):`, error.message);
                }
            }

            console.log('모든 헤드라인 분석 완료');
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('헤드라인 작업 중 오류 발생:', error);
    }
});

// 서버 실행
app.listen(60027, () => {
    console.log('서버가 60027번 포트에서 실행 중입니다.');
});