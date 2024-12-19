import requests
from bs4 import BeautifulSoup
import json

# 네이버 뉴스 '많이 본 뉴스' URL
url = 'https://news.naver.com/main/ranking/popularDay.naver'

# 관심 있는 언론사 리스트
target_press = ["JTBC", "KBS", "SBS", "국민일보", "아시아경제"]

def scrape_headlines():
    # 네이버 뉴스 '많이 본 뉴스' 페이지 요청
    response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
    response.raise_for_status()  # 요청이 실패하면 예외 발생
    soup = BeautifulSoup(response.text, 'html.parser')  # HTML 파싱

    results = []
    # 각 언론사의 기사 목록을 찾는 루프
    for box in soup.find_all('div', class_='rankingnews_box'):
        press_name_tag = box.find('strong', class_='rankingnews_name')
        if press_name_tag:
            press_name = press_name_tag.get_text(strip=True)  # 언론사 이름 추출
            if press_name in target_press:  # 관심 있는 언론사인지 확인
                articles = box.find_all('li')[:10]  # 상위 10개 기사만 저장
                for article in articles:
                    link_tag = article.find('a')  # 기사 링크 추출
                    if link_tag and link_tag['href']:
                        title = link_tag.get_text(strip=True)  # 기사 제목 추출
                        link = link_tag['href']  # 기사 URL 추출
                        results.append({'press_name': press_name, 'title': title, 'url': link})  # 결과 리스트에 추가
    return results

if __name__ == '__main__':
    headlines = scrape_headlines()  # 뉴스 헤드라인 크롤링
    print(json.dumps(headlines, ensure_ascii=False))  # 결과를 JSON 형태로 출력


# ["JTBC", "한국경제", "YTN", "서울경제", "머니투데이",
#                "아시아경제", "KBS", "국민일보", "SBS", "이데일리",
#                "매일경제", "MBC"]