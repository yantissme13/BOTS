from flask import Flask, request, jsonify
from rapidfuzz import fuzz, process

app = Flask(__name__)

@app.route('/match', methods=['POST'])
def match():
    data = request.get_json()

    new_event = data.get("new_event")
    existing_events = data.get("existing_events", [])

    if not new_event or not isinstance(existing_events, list):
        print("❌ Données invalides reçues:", data)  # 👈 DEBUG ici
        return jsonify({"error": "Invalid input"}), 400

    match_result = process.extractOne(new_event, existing_events, scorer=fuzz.token_sort_ratio)

    SEUIL_MIN = 85  # 👈 tu peux adapter ce seuil si nécessaire

    if match_result:
        match, score, _ = match_result
        print(f"🧠 Comparaison NLP : '{new_event}' ≈ '{match}' (score: {score})")  # 👈 log utile

        if score >= SEUIL_MIN:
            return jsonify({"match": match, "score": score})
        else:
            return jsonify({"match": None, "score": score})  # score trop bas
    else:
        return jsonify({"match": None, "score": 0})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)
