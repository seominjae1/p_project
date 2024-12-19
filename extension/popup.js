document.addEventListener('DOMContentLoaded', function () {
  const mainTab = document.getElementById('main-tab');
  const headlineTab = document.getElementById('headline-tab');
  const mainContent = document.getElementById('main-content');
  const headlineContent = document.getElementById('headline-content');
  const newsSelect = document.getElementById('news-select');
  const headlinesContainer = document.getElementById('headlineNewsDisplay');
  const getUrlBtn = document.getElementById('get-url-btn');
  const titleDisplay = document.getElementById('titleDisplay');
  const contentDisplay = document.getElementById('contentDisplay');
  const errorDisplay = document.getElementById('errorDisplay');

  // 탭 전환 로직
  mainTab.addEventListener('click', () => {
    mainTab.classList.add('active');
    headlineTab.classList.remove('active');
    mainContent.classList.add('active');
    headlineContent.classList.remove('active');
  });


  //  유사기사 출력


  headlineTab.addEventListener('click', () => {
    headlineTab.classList.add('active');
    mainTab.classList.remove('active');
    headlineContent.classList.add('active');
    mainContent.classList.remove('active');
  });

  // Analyze 버튼 로직
  getUrlBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        errorDisplay.textContent = 'No active tab found.';
        return;
      }

      const url = tabs[0].url;

      //로딩 구현
      document.getElementById('loadingContainer').style.display='block';
      document.getElementById('completedContainer').style.display='none';

      fetch('http://ceprj.gachon.ac.kr:60027/api/receive-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })
        .then((response) => {
          if (!response.ok) return response.json().then((data) => {
            throw new Error(data.error || 'HTTP error');})
          return response.json();
        })
        .then((data) => {
          //로딩 구현
          document.getElementById('loadingContainer').style.display = 'none';
          document.getElementById('completedContainer').style.display = 'block';

          const realNewsPro = (parseFloat(data.real_news_probability) * 100).toFixed(2);
          const fakeNewsPro = (parseFloat(data.fake_news_probability) * 100).toFixed(2);

          titleDisplay.textContent = `Real News Probability: ${realNewsPro}%`;
          contentDisplay.textContent = `Fake News Probability: ${fakeNewsPro}%`;

          drawPieChart([realNewsPro, fakeNewsPro]);


          if (parseFloat(fakeNewsPro) >= 80) {       //경고
            const relatedText = document.createElement('p');
            
            relatedText.style.color = 'red'; // 경고 메시지 색상
            relatedText.style.fontWeight = 'bold'; // 글자 강조 (굵게)
            relatedText.style.fontSize = '17px'; // 글자 크기 조정
            relatedText.style.textAlign = 'center'; // 중앙 정렬
            relatedText.style.marginTop = '20px'; // 위쪽 여백 추가
            relatedText.textContent = '기사 제목과 본문이 관련 없을 가능성이 높습니다';
            contentDisplay.appendChild(relatedText);
          }

          const similarArticlesContainer = document.getElementById('similarArticles');
          similarArticlesContainer.innerHTML = ''; // 기존 내용을 초기화

          data.sim.forEach((article) => {
              const sim = document.createElement('div');
              sim.innerHTML = `
                  <p><a href="${article.url}" target="_blank">${article.title}</a> - real: ${article.probability}</p>
              `;
              similarArticlesContainer.appendChild(sim); // sim 요소를 추가
          });
        })
        .catch((error) => {
          document.getElementById('loadingContainer').style.display = 'none'; // 로딩 중단


          // 완료 컨테이너 표시
          const completedContainer = document.getElementById('completedContainer');
          completedContainer.style.display = 'block';

          const errorDisplay = document.getElementById('errorDisplay');

          errorDisplay.style.display = 'block';  //에러표시활성화

          errorDisplay.textContent = `Error: ${error.message}`;
        });
    });
  });

  // 헤드라인 뉴스 표시 로직
  newsSelect.addEventListener('change', () => {
    const selectedNewsOutlet = newsSelect.value;

    if (!selectedNewsOutlet) {
      headlinesContainer.innerHTML = '<p>언론사를 선택하세요.</p>';
      return;
    }

    fetch('http://ceprj.gachon.ac.kr:60027/api/headlines')
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.json();
      })
      .then(headlines => {
        headlinesContainer.innerHTML = '';

        const filteredHeadlines = headlines.filter(
          headline => headline.press_name.toLowerCase() === selectedNewsOutlet.toLowerCase()
        );

        if (filteredHeadlines.length === 0) {
          headlinesContainer.innerHTML = `<p>${selectedNewsOutlet}에 대한 헤드라인이 없습니다.</p>`;
          return;
        }

        filteredHeadlines.forEach(headline => {
          const trimmedTitle = headline.title.length > 50 
            ? `${headline.title.substring(0, 50)}...` 
            : headline.title;

          // 제목과 그래프를 감싸는 div 생성
          const headlineContainer = document.createElement('div');
          headlineContainer.style.display = 'flex';
          headlineContainer.style.alignItems = 'center';

          // 제목 div 생성
          const headlineElement = document.createElement('div');
          headlineElement.innerHTML = `
            <a href="${headline.url}" target="_blank">${trimmedTitle}</a>
          `;

          // 그래프 캔버스 생성
          const graphCanvas = document.createElement('canvas');
          graphCanvas.width = 200;
          graphCanvas.height = 20;

          // headlineContainer에 제목과 그래프 추가
          headlineContainer.appendChild(headlineElement);
          headlineContainer.appendChild(graphCanvas);
          headlinesContainer.appendChild(headlineContainer);

          // 그래프 그리기
          const ctx = graphCanvas.getContext('2d');
          drawInlineBarChart(ctx, headline.real_news_probability * 100);
        });
      })
      .catch(error => {
        headlinesContainer.innerHTML = `<p>헤드라인을 가져오는 중 오류가 발생했습니다: ${error.message}</p>`;
      });
  });

  // 제목 옆에 표시할 가로 막대그래프 그리기 함수
  function drawInlineBarChart(ctx, value) {
    ctx.clearRect(0, 0, 200, 20); // 기존 캔버스 내용 제거

    // 배경 그리기
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(0, 0, 200, 20);

    // 값에 따른 막대 그리기
    ctx.fillStyle = '#36A2EB';
    ctx.fillRect(0, 0, value * 2, 20);

    // 텍스트 표시
    ctx.fillStyle = '#000';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${value.toFixed(1)}%`, 100, 10);
  }

  // 원형 차트 생성 함수
  function drawPieChart(values) {
    const ctx = document.getElementById('myPieChart').getContext('2d');

    if (window.myPieChart && typeof window.myPieChart.destroy === 'function') {
      window.myPieChart.destroy();
    }

    window.myPieChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['Real News', 'Fake News'],
        datasets: [
          {
            data: values,
            backgroundColor: ['#36A2EB', '#FF6384'],
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'top' },
        },
      },
    });
  }
});
document.getElementById('redirectButton').addEventListener('click', function() {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      chrome.tabs.update(tabs[0].id, { url: 'http://ceprj.gachon.ac.kr:60027/help' });
  });
});

        





