import os
import sys
import json
import torch
import pymysql
from kobert_transformers import get_kobert_model, get_tokenizer
import torch.nn as nn
import torch.nn.functional as F

# KoBERT 모델 및 토크나이저 초기화
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")  # GPU가 있다면 GPU 사용, 없으면 CPU 사용
kobert_model = get_kobert_model().to(device)  # KoBERT 모델 로드
tokenizer = get_tokenizer()  # KoBERT 토크나이저 로드

# MariaDB 연결 설정
def get_db_connection():
    # 데이터베이스 연결 함수
    return pymysql.connect(
        host="localhost",
        user="dbid233",
        password="dbpass233",
        database="db24327",
        charset="utf8mb4",
        port=3306,
        cursorclass=pymysql.cursors.DictCursor,
    )

# KoBERTComparisonClassifier 정의
class KoBERTComparisonClassifier(nn.Module):
    def __init__(self, kobert_model, hidden_size=768, num_classes=2):
        super(KoBERTComparisonClassifier, self).__init__()
        self.bert = kobert_model  # KoBERT 모델 사용
        self.classifier = nn.Sequential(
            nn.Linear(hidden_size * 2, 128),  # 두 입력을 합쳐서 분류
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, num_classes)  # 두 클래스 (실제 뉴스/가짜 뉴스)
        )

    def forward(self, title_input_ids, title_attention_mask, content_input_ids, content_attention_mask):
        # 제목과 내용을 BERT로 처리하여 CLS 토큰 출력 추출 후 분류
        title_outputs = self.bert(input_ids=title_input_ids, attention_mask=title_attention_mask)
        title_cls_output = title_outputs.last_hidden_state[:, 0, :]

        # 내용 처리
        batch_size, num_chunks, seq_len = content_input_ids.size()
        content_input_ids = content_input_ids.view(-1, seq_len)
        content_attention_mask = content_attention_mask.view(-1, seq_len)
        content_outputs = self.bert(input_ids=content_input_ids, attention_mask=content_attention_mask)
        content_cls_output = content_outputs.last_hidden_state[:, 0, :]
        content_cls_output = content_cls_output.view(batch_size, num_chunks, -1).mean(dim=1)

        # 제목과 내용을 합쳐서 최종 분류
        combined_cls_output = torch.cat((title_cls_output, content_cls_output), dim=1)
        return self.classifier(combined_cls_output)

# 모델 로드 함수
def load_model(model, path):
    # 저장된 모델을 로드하는 함수
    model.load_state_dict(torch.load(path, map_location=device))
    print(f"Model loaded from {path}")

# 데이터 전처리 함수
def preprocess_input(title, content, tokenizer, max_len=512, stride=256):
    # 제목과 내용을 토크나이즈하고 패딩 및 자르기 처리
    title_inputs = tokenizer(
        title, max_length=max_len, padding="max_length", truncation=True, return_tensors="pt"
    )

    content_inputs = tokenizer(
        content, max_length=max_len, padding="max_length", truncation=True,
        stride=stride, return_overflowing_tokens=True, return_tensors="pt"
    )

    return {
        'title_input_ids': title_inputs['input_ids'].squeeze(0),
        'title_attention_mask': title_inputs['attention_mask'].squeeze(0),
        'content_input_ids': content_inputs['input_ids'],
        'content_attention_mask': content_inputs['attention_mask']
    }

# 예측 함수
def predict(title, content, model, tokenizer):
    model.eval()  # 예측 모드로 설정
    inputs = preprocess_input(title, content, tokenizer)  # 데이터 전처리
    with torch.no_grad():  # 그래디언트 계산하지 않음
        # 입력 데이터를 모델에 넣어 예측 결과 얻기
        title_input_ids = inputs['title_input_ids'].unsqueeze(0).to(device)
        title_attention_mask = inputs['title_attention_mask'].unsqueeze(0).to(device)
        content_input_ids = inputs['content_input_ids'].unsqueeze(0).to(device)
        content_attention_mask = inputs['content_attention_mask'].unsqueeze(0).to(device)

        logits = model(title_input_ids, title_attention_mask, content_input_ids, content_attention_mask)  # 예측
        probabilities = F.softmax(logits, dim=1).squeeze(0)  # 소프트맥스 함수로 확률 계산
        pred_class = torch.argmax(probabilities).item()  # 확률이 가장 높은 클래스
        return pred_class, probabilities

try:
    # URL이 명령줄 인자로 제공되지 않으면 예외 발생
    if len(sys.argv) < 2:
        raise ValueError("URL이 명령줄 인자로 제공되지 않았습니다.")

    url = sys.argv[1]

    # 데이터베이스 연결 및 기사 정보 가져오기
    connection = get_db_connection()

    with connection.cursor() as cursor:
        cursor.execute("SELECT id, title, content FROM scraped_articles WHERE url = %s", (url,))
        article = cursor.fetchone()

        if not article:
            raise ValueError(f"URL {url}에 해당하는 기사를 찾을 수 없습니다.")

        article_id = article["id"]
        title = article["title"]
        content = article["content"]

    # 모델 초기화 및 로드
    model = KoBERTComparisonClassifier(kobert_model)
    model_path = os.path.join(os.path.dirname(__file__), "fine_tuned_model.pth")  # 저장된 모델 경로
    load_model(model, model_path)
    model = model.to(device)

    # 예측
    pred_class, probabilities = predict(title, content, model, tokenizer)
    real_news_probability = probabilities[1].item()  # 비낚시성 확률
    fake_news_probability = probabilities[0].item()  # 낚시성 확률

    # 예측 결과를 데이터베이스에 저장
    with connection.cursor() as cursor:
        # 중복 확인 및 삽입
        cursor.execute("SELECT * FROM predictions WHERE article_id = %s", (article_id,))
        existing = cursor.fetchone()

        if existing:
            print("Debug: 이미 예측 결과가 존재합니다. 데이터베이스에 삽입하지 않습니다.")
        else:
            cursor.execute(
                """
                INSERT INTO predictions (article_id, real_news_probability, fake_news_probability, created_at)
                VALUES (%s, %s, %s, NOW())
                """,
                (article_id, real_news_probability, fake_news_probability)
            )
            connection.commit()
            print("Debug: 데이터베이스 삽입 성공")

    # 결과 출력
    result = {
        "real_news_probability": real_news_probability,
        "fake_news_probability": fake_news_probability,
    }
    print(json.dumps(result))

except Exception as e:
    # 오류 발생 시 예외 처리
    error_result = {"error": str(e)}
    print(json.dumps(error_result))

finally:
    # 데이터베이스 연결 종료
    if 'connection' in locals() and connection.open:
        connection.close()
